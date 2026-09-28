/**
 * Operability — webhook security primitives (src/server/webhooks/*).
 *
 * No provider webhook exists yet (Telegram et al. are separate workstreams).
 * These tests pin the reusable boundary every future provider route will use:
 * raw-body signatures, constant-time comparison, timestamp tolerance, replay
 * protection, bounded bodies, rate limiting and generic rejections.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkTimestampTolerance,
  computeHmac,
  readRawBody,
  timingSafeEqual,
  verifyHmacSignature,
  verifySharedSecret,
  verifyWebhookRequest,
  webhookRejection,
  WebhookBodyTooLargeError,
  type WebhookProviderSpec,
} from "@/server/webhooks/security";
import { MemoryWebhookReceiptStore, PostgresWebhookReceiptStore } from "@/server/webhooks/receipts";
import { MemoryRateLimitStore } from "@/server/rate-limit/store";
import { resetRateLimitFallbackStore, setPrimaryRateLimitStore } from "@/server/rate-limit/limiter";
import { RATE_LIMITS } from "@/server/rate-limit/policies";
import { setLogSink } from "@/server/observability/logger";

const SECRET = "test-webhook-secret-not-real";
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

let restoreStore: () => void = () => {};
let restoreLogs: () => void = () => {};
let logs: string[] = [];

beforeEach(() => {
  restoreStore = setPrimaryRateLimitStore(new MemoryRateLimitStore());
  resetRateLimitFallbackStore();
  logs = [];
  restoreLogs = setLogSink((_level, line) => logs.push(line));
});
afterEach(() => {
  restoreStore();
  restoreLogs();
});

// ── Primitives ──────────────────────────────────────────────────────────────

describe("constant-time comparison", () => {
  it("matches only identical values, including on length mismatch", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  });

  it("does not early-exit (the loop always walks the longer input)", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/server/webhooks/security.ts"),
      "utf8",
    );
    const body = source.slice(source.indexOf("export function timingSafeEqual"));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    expect(fn).not.toMatch(/return false/);
    expect(fn).toContain("Math.max(left.length, right.length)");
  });
});

describe("HMAC signatures over the raw body", () => {
  const body = '{"update_id":42,"message":{"text":"hi"}}';

  it("accepts the correct signature (hex and base64, with a scheme prefix)", async () => {
    const hex = await computeHmac(SECRET, body);
    expect(await verifyHmacSignature({ secret: SECRET, payload: body, signature: hex })).toBe(true);
    expect(
      await verifyHmacSignature({
        secret: SECRET,
        payload: body,
        signature: `sha256=${hex.toUpperCase()}`,
        prefix: "sha256=",
      }),
    ).toBe(true);
    const b64 = await computeHmac(SECRET, body, "SHA-256", "base64");
    expect(
      await verifyHmacSignature({
        secret: SECRET,
        payload: body,
        signature: b64,
        encoding: "base64",
      }),
    ).toBe(true);
  });

  it("rejects a wrong secret, a tampered body, a re-serialized body and junk", async () => {
    const good = await computeHmac(SECRET, body);
    expect(await verifyHmacSignature({ secret: "other", payload: body, signature: good })).toBe(
      false,
    );
    expect(
      await verifyHmacSignature({
        secret: SECRET,
        payload: body.replace("42", "43"),
        signature: good,
      }),
    ).toBe(false);
    // Parsing then re-stringifying changes bytes — which is why the raw body is kept.
    const reserialized = JSON.stringify(JSON.parse(body), null, 1);
    expect(
      await verifyHmacSignature({ secret: SECRET, payload: reserialized, signature: good }),
    ).toBe(false);
    for (const signature of [null, undefined, "", "x".repeat(2000), `sha1=${good}`]) {
      expect(
        await verifyHmacSignature({ secret: SECRET, payload: body, signature, prefix: "sha256=" }),
      ).toBe(false);
    }
  });

  it("shared-secret headers: constant-time, and an unset secret never matches", () => {
    expect(verifySharedSecret("s3cret", "s3cret")).toBe(true);
    expect(verifySharedSecret("s3cret", "s3cre")).toBe(false);
    expect(verifySharedSecret(undefined, "")).toBe(false);
    expect(verifySharedSecret("", "")).toBe(false);
  });
});

describe("timestamp tolerance", () => {
  it("accepts within ±tolerance and rejects outside it", () => {
    expect(checkTimestampTolerance(NOW_S, NOW_MS)).toBe("ok");
    expect(checkTimestampTolerance(NOW_S - 300, NOW_MS)).toBe("ok");
    expect(checkTimestampTolerance(NOW_S - 301, NOW_MS)).toBe("too_old");
    expect(checkTimestampTolerance(NOW_S + 301, NOW_MS)).toBe("in_future");
    expect(checkTimestampTolerance(String(NOW_S), NOW_MS)).toBe("ok");
  });

  it("rejects missing or malformed timestamps", () => {
    for (const bad of [null, undefined, "", "abc", "12.5e3", -1, 0, Number.NaN]) {
      expect(checkTimestampTolerance(bad as never, NOW_MS)).toBe("invalid");
    }
  });
});

describe("raw body", () => {
  it("returns the exact bytes received", async () => {
    const bytes = new TextEncoder().encode('{"a": 1,  "b":"ខ្មែរ"}');
    const request = new Request("https://apsa.test/hook", { method: "POST", body: bytes });
    expect(await readRawBody(request)).toEqual(bytes);
  });

  it("refuses an oversized body by header and while streaming", async () => {
    const big = new Request("https://apsa.test/hook", {
      method: "POST",
      body: "x".repeat(2048),
      headers: { "content-length": "2048" },
    });
    await expect(readRawBody(big, 1024)).rejects.toBeInstanceOf(WebhookBodyTooLargeError);
    const lying = new Request("https://apsa.test/hook", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(800));
          controller.enqueue(new Uint8Array(800));
          controller.close();
        },
      }),
      // @ts-expect-error -- Bun requires duplex for streamed request bodies.
      duplex: "half",
    });
    await expect(readRawBody(lying, 1024)).rejects.toBeInstanceOf(WebhookBodyTooLargeError);
  });
});

// ── Full pipeline ───────────────────────────────────────────────────────────

describe("verifyWebhookRequest", () => {
  const spec: WebhookProviderSpec = {
    provider: "testprovider",
    maxBodyBytes: 4096,
    async verifySignature(raw, headers) {
      const timestamp = headers.get("x-test-timestamp") ?? "";
      const payload = `${timestamp}.${new TextDecoder().decode(raw)}`;
      return verifyHmacSignature({
        secret: SECRET,
        payload,
        signature: headers.get("x-test-signature"),
        prefix: "v1=",
      });
    },
    signedTimestamp: (_raw, headers) => headers.get("x-test-timestamp"),
    eventId: (raw) => (JSON.parse(new TextDecoder().decode(raw)) as { id?: string }).id,
  };

  async function signedRequest(
    body: string,
    options: { timestamp?: number; secret?: string; method?: string } = {},
  ) {
    const timestamp = String(options.timestamp ?? NOW_S);
    const signature = await computeHmac(options.secret ?? SECRET, `${timestamp}.${body}`);
    return new Request("https://apsa.test/hook", {
      method: options.method ?? "POST",
      body: options.method === "GET" ? undefined : body,
      headers: { "x-test-timestamp": timestamp, "x-test-signature": `v1=${signature}` },
    });
  }

  it("accepts a valid, fresh, first-seen event and hands back the raw body", async () => {
    const receipts = new MemoryWebhookReceiptStore();
    const body = '{"id":"evt_1","amount":100}';
    const result = await verifyWebhookRequest(await signedRequest(body), spec, {
      receipts,
      clientIp: "203.0.113.7",
      nowMs: NOW_MS,
    });
    expect(result.ok && !result.duplicate).toBe(true);
    if (result.ok && !result.duplicate) {
      expect(result.eventId).toBe("evt_1");
      expect(new TextDecoder().decode(result.rawBody)).toBe(body);
    }
  });

  it("rejects an invalid signature before reading the event", async () => {
    const receipts = new MemoryWebhookReceiptStore();
    const result = await verifyWebhookRequest(
      await signedRequest('{"id":"evt_2"}', { secret: "attacker" }),
      spec,
      { receipts, clientIp: null, nowMs: NOW_MS },
    );
    expect(result).toEqual({ ok: false, status: 401, reason: "bad_signature" });
    // The event was never claimed: a later genuine delivery is still processed.
    expect(await receipts.claim("testprovider", "evt_2")).toBe(true);
  });

  it("rejects a replay of a captured request outside the tolerance window", async () => {
    const receipts = new MemoryWebhookReceiptStore();
    const stale = await signedRequest('{"id":"evt_3"}', { timestamp: NOW_S - 3600 });
    const result = await verifyWebhookRequest(stale, spec, {
      receipts,
      clientIp: null,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, status: 401, reason: "stale_timestamp" });
  });

  it("flags a replay inside the window as a duplicate — acknowledged, not processed", async () => {
    const receipts = new MemoryWebhookReceiptStore();
    const body = '{"id":"evt_4"}';
    const first = await verifyWebhookRequest(await signedRequest(body), spec, {
      receipts,
      clientIp: null,
      nowMs: NOW_MS,
    });
    const replay = await verifyWebhookRequest(await signedRequest(body), spec, {
      receipts,
      clientIp: null,
      nowMs: NOW_MS,
    });
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(replay).toEqual({ ok: true, duplicate: true, eventId: "evt_4" });
  });

  it("a released claim (failed processing) lets the provider retry through", async () => {
    const receipts = new MemoryWebhookReceiptStore();
    expect(await receipts.claim("p", "e")).toBe(true);
    await receipts.release("p", "e");
    expect(await receipts.claim("p", "e")).toBe(true);
  });

  it("rejects a missing event id, a wrong method and an oversized body", async () => {
    const receipts = new MemoryWebhookReceiptStore();
    const opts = { receipts, clientIp: null, nowMs: NOW_MS };
    expect(await verifyWebhookRequest(await signedRequest('{"x":1}'), spec, opts)).toEqual({
      ok: false,
      status: 400,
      reason: "missing_event_id",
    });
    expect(
      await verifyWebhookRequest(await signedRequest("", { method: "GET" }), spec, opts),
    ).toEqual({ ok: false, status: 405, reason: "method_not_allowed" });
    const huge = `{"id":"evt_big","pad":"${"x".repeat(5000)}"}`;
    expect(await verifyWebhookRequest(await signedRequest(huge), spec, opts)).toEqual({
      ok: false,
      status: 413,
      reason: "body_too_large",
    });
  });

  it("rate-limits per provider and client IP before any signature work", async () => {
    const receipts = new MemoryWebhookReceiptStore();
    const limit = RATE_LIMITS.webhookIp.limit;
    let last;
    for (let i = 0; i <= limit; i++) {
      last = await verifyWebhookRequest(await signedRequest("{}", { secret: "wrong" }), spec, {
        receipts,
        clientIp: "198.51.100.23",
        nowMs: NOW_MS,
      });
    }
    expect(last).toEqual({ ok: false, status: 429, reason: "rate_limited" });
    // Another IP is unaffected.
    const other = await verifyWebhookRequest(await signedRequest('{"id":"evt_5"}'), spec, {
      receipts,
      clientIp: "198.51.100.24",
      nowMs: NOW_MS,
    });
    expect(other).toMatchObject({ ok: true, duplicate: false });
  });

  it("rejections are generic and the logs never contain the secret or signature", async () => {
    const rejection = webhookRejection(401);
    expect(rejection.status).toBe(401);
    expect(await rejection.text()).toBe('{"ok":false}');
    const receipts = new MemoryWebhookReceiptStore();
    await verifyWebhookRequest(await signedRequest('{"id":"evt_6"}', { secret: "bad" }), spec, {
      receipts,
      clientIp: null,
      nowMs: NOW_MS,
    });
    const joined = logs.join("\n");
    expect(joined).toContain("webhook.rejected");
    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain("v1=");
  });
});

describe("receipt stores", () => {
  it("PostgreSQL store calls the migration-045 RPCs and fails closed on error", async () => {
    const calls: string[] = [];
    const ok = new PostgresWebhookReceiptStore({
      rpc: async (fn) => {
        calls.push(fn);
        return { data: fn === "claim_webhook_event" ? true : true, error: null };
      },
    });
    expect(await ok.claim("telegram", "1")).toBe(true);
    await ok.release("telegram", "1");
    expect(calls).toEqual(["claim_webhook_event", "release_webhook_event"]);

    const broken = new PostgresWebhookReceiptStore({
      rpc: async () => ({ data: null, error: { code: "PGRST202" } }),
    });
    await expect(broken.claim("telegram", "1")).rejects.toThrow(
      "webhook receipt store unavailable",
    );
  });

  it("no provider webhook route is exposed", () => {
    const routes = fs.readdirSync(path.join(process.cwd(), "src/routes"));
    expect(routes.filter((r) => /webhook|telegram/i.test(r))).toEqual([]);
  });
});
