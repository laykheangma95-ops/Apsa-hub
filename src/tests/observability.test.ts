/**
 * Operability — error tracking, structured logging, request IDs and the
 * server-function boundary (src/server/observability/*, src/lib/public-error.ts).
 *
 * Behavioral: every assertion drives the real module and inspects what would
 * reach a log line or the browser.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { REDACTED, redact, scrubString } from "@/server/observability/redact";
import { isRequestId, newRequestId } from "@/server/observability/request-id";
import { currentRequestId, runWithRequestContext } from "@/server/observability/request-context";
import { buildLogRecord, serverLog, setLogSink } from "@/server/observability/logger";
import {
  describeErrorForLog,
  isPublicDomainError,
  registerErrorReporter,
  reportServerError,
  type SanitizedErrorReport,
} from "@/server/observability/errors";
import { domainFromFilename, runServerFnBoundary } from "@/server/observability/server-fn-boundary";
import {
  INTERNAL_ERROR_MESSAGE,
  formatInternalErrorMessage,
  isRateLimitedError,
  supportReferenceOf,
} from "@/lib/public-error";
import { RateLimitedError } from "@/server/rate-limit/errors";
import { classifyOrderError } from "@/lib/orders";
import { classifyPaymentError } from "@/lib/payments";
import { classifyCustomerError } from "@/lib/customers-view";
import { classifyCatalogError } from "@/lib/catalog";
import { classifyInventoryError } from "@/lib/inventory";
import { classifyDeliveryError } from "@/lib/deliveries";

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

function captureLogs() {
  const lines: Array<{ level: string; record: Record<string, unknown>; raw: string }> = [];
  const restore = setLogSink((level, line) => {
    lines.push({ level, record: JSON.parse(line) as Record<string, unknown>, raw: line });
  });
  return { lines, restore };
}

afterEach(() => {
  registerErrorReporter(null);
});

// ── Redaction ────────────────────────────────────────────────────────────────

describe("log redaction", () => {
  const SENSITIVE = {
    password: "hunter2-password",
    newPassword: "another-pass",
    access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl",
    refreshToken: "refresh-token-value-123",
    recoveryToken: "recovery-token-xyz",
    cookie: "sb-access-token=abc; sb-refresh-token=def",
    authorization: "Bearer abcdefghijklmnop",
    apiKey: "sk_live_1234567890",
    customerEmail: "customer@example.com",
    customerPhone: "+855 12 345 678",
    cardNumber: "4111 1111 1111 1111",
    messageBody: "Hello, I want 2 shirts, my address is Street 51",
    webhookSecret: "whsec_abcdefghijklmnopqrstuvwxyz",
  };

  it("replaces every sensitive field by NAME, whatever its value", () => {
    const out = redact(SENSITIVE) as Record<string, unknown>;
    for (const key of Object.keys(SENSITIVE)) {
      expect({ key, value: out[key] }).toEqual({ key, value: REDACTED });
    }
    const serialized = JSON.stringify(out);
    for (const value of Object.values(SENSITIVE)) {
      expect({ value, leaked: serialized.includes(value) }).toEqual({ value, leaked: false });
    }
  });

  it("scrubs credentials and contact details hiding under innocent keys", () => {
    const text =
      'duplicate key value violates unique constraint "customers_email_key" ' +
      "Key (primary_email)=(someone@example.com) already exists; phone +855 12 345 678; " +
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl; " +
      "card 4111-1111-1111-1111; url https://x.test/?token=abc123&apikey=zzz";
    const scrubbed = scrubString(text);
    for (const secret of [
      "someone@example.com",
      "+855 12 345 678",
      "eyJhbGciOiJIUzI1NiJ9",
      "4111-1111-1111-1111",
      "token=abc123",
      "apikey=zzz",
    ]) {
      expect({ secret, leaked: scrubbed.includes(secret) }).toEqual({ secret, leaked: false });
    }
  });

  it("keeps identifiers, timestamps and codes intact", () => {
    const uuid = "aaaaaaaa-0000-4000-8000-000000000001";
    const out = redact({
      organizationId: uuid,
      userId: uuid,
      requestId: "req_0123456789abcdef0123",
      ts: "2026-09-28T10:11:12.345Z",
      errorCode: "PGRST116",
      statusCode: 409,
      note: "free text",
    }) as Record<string, unknown>;
    expect(out["organizationId"]).toBe(uuid);
    expect(out["userId"]).toBe(uuid);
    expect(out["requestId"]).toBe("req_0123456789abcdef0123");
    expect(out["ts"]).toBe("2026-09-28T10:11:12.345Z");
    expect(out["errorCode"]).toBe("PGRST116");
    expect(out["statusCode"]).toBe(409);
    expect(out["note"]).toBe(REDACTED);
  });

  it("walks nested objects and arrays, and survives cycles", () => {
    const cyclic: Record<string, unknown> = { items: [{ password: "p" }, { email: "a@b.co" }] };
    cyclic["self"] = cyclic;
    const out = JSON.stringify(redact(cyclic));
    expect(out).not.toContain('"p"');
    expect(out).not.toContain("a@b.co");
    expect(out).toContain("[Circular]");
  });

  it("truncates very long strings", () => {
    expect(scrubString("x ".repeat(2000)).length).toBeLessThan(600);
  });
});

// ── Request IDs ──────────────────────────────────────────────────────────────

describe("request IDs", () => {
  it("are random, well-formed and unique", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newRequestId()));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(isRequestId(id)).toBe(true);
  });

  it("carry no information: no email, tenant, member, timestamp or sequence", () => {
    const id = newRequestId();
    expect(id).toMatch(/^req_[0-9a-f]{20}$/);
    // Two IDs minted back-to-back share no ordered prefix beyond "req_".
    const a = newRequestId().slice(4);
    const b = newRequestId().slice(4);
    expect(a).not.toBe(b);
    expect(id).not.toContain("@");
    expect(id).not.toContain(String(new Date().getUTCFullYear()));
  });

  it("are never an authorization input", () => {
    const sources = [
      read("src/server/observability/request-id.ts"),
      read("src/server/observability/request-context.ts"),
    ].join("\n");
    expect(sources).toContain("never an authentication or");
    // No auth module reads a request ID.
    for (const file of ["src/server/auth/authorization.ts", "src/server/auth/membership.ts"]) {
      expect(read(file)).not.toContain("requestId");
    }
  });
});

// ── Structured logging ──────────────────────────────────────────────────────

describe("structured server logging", () => {
  it("emits one JSON line with the fixed fields and the request context", async () => {
    const { lines, restore } = captureLogs();
    await runWithRequestContext(
      { requestId: "req_aaaaaaaaaaaaaaaaaaaa", domain: "orders", operation: "createOrderFn" },
      async () => {
        serverLog.error("orders.create_failed", {
          organizationId: "aaaaaaaa-0000-4000-8000-000000000001",
          userId: "aaaaaaaa-0000-4000-8000-000000000002",
          errorClass: "Error",
          errorCode: "idempotency_conflict",
          statusCode: 409,
          retryable: false,
          password: "leak-me",
        });
      },
    );
    restore();
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line!.raw.includes("\n")).toBe(false);
    expect(line!.record).toMatchObject({
      level: "error",
      event: "orders.create_failed",
      requestId: "req_aaaaaaaaaaaaaaaaaaaa",
      domain: "orders",
      operation: "createOrderFn",
      organizationId: "aaaaaaaa-0000-4000-8000-000000000001",
      userId: "aaaaaaaa-0000-4000-8000-000000000002",
      errorClass: "Error",
      errorCode: "idempotency_conflict",
      statusCode: 409,
      retryable: false,
      password: REDACTED,
    });
    expect(typeof line!.record["ts"]).toBe("string");
    expect(line!.raw).not.toContain("leak-me");
  });

  it("never throws, even for an unserializable payload", () => {
    const restore = setLogSink(() => {
      throw new Error("sink down");
    });
    expect(() => serverLog.info("x", { big: BigInt(1) })).not.toThrow();
    restore();
    expect(buildLogRecord("info", "x", { big: BigInt(5) as unknown })["big"]).toBe("5");
  });

  it("describes an error by class, code, status and scrubbed message — stack frames only", () => {
    const error = Object.assign(new Error("Key (email)=(x@y.co) exists"), {
      statusCode: 500,
      code: "23505",
    });
    const description = describeErrorForLog(error);
    expect(description).toMatchObject({
      errorClass: "Error",
      errorCode: "23505",
      statusCode: 500,
      retryable: true,
    });
    expect(description.errorMessage).not.toContain("x@y.co");
    expect(description.stack ?? "").not.toContain("x@y.co");
  });
});

// ── Error reporting abstraction ─────────────────────────────────────────────

describe("provider-neutral error reporting", () => {
  it("works with no provider registered — the log line is the baseline sink", () => {
    const { lines, restore } = captureLogs();
    reportServerError(new Error("boom"), { event: "test.failure" });
    restore();
    expect(lines.map((l) => l.record["event"])).toEqual(["test.failure"]);
  });

  it("forwards only the sanitized report to a registered provider", async () => {
    const reports: SanitizedErrorReport[] = [];
    registerErrorReporter({ name: "test", capture: (report) => void reports.push(report) });
    const { restore } = captureLogs();
    await runWithRequestContext({ requestId: "req_bbbbbbbbbbbbbbbbbbbb" }, async () => {
      reportServerError(new Error("failed for owner@example.com"), {
        organizationId: "aaaaaaaa-0000-4000-8000-000000000001",
      });
    });
    restore();
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.requestId).toBe("req_bbbbbbbbbbbbbbbbbbbb");
    expect(report.organizationId).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(JSON.stringify(report)).not.toContain("owner@example.com");
    expect(Object.keys(report)).not.toContain("error");
  });

  it("a failing provider never breaks the operation", () => {
    registerErrorReporter({
      name: "broken",
      capture: () => {
        throw new Error("provider down");
      },
    });
    const { lines, restore } = captureLogs();
    expect(() => reportServerError(new Error("x"))).not.toThrow();
    restore();
    expect(lines.map((l) => l.record["event"])).toContain("error_reporter.capture_failed");
  });

  it("no provider credential or SDK is fabricated", () => {
    const pkg = read("package.json");
    expect(pkg).not.toMatch(/@sentry\/|@opentelemetry\//);
    expect(read("src/server/observability/errors.ts")).toContain("none is invented here");
  });
});

// ── Server-function boundary ────────────────────────────────────────────────

describe("server-function boundary", () => {
  const meta = { name: "createOrderFn", filename: "src/api/orders.ts" };

  it("derives the domain from the API file", () => {
    expect(domainFromFilename("src/api/orders.ts")).toBe("orders");
    expect(domainFromFilename("/abs/src/api/payments.ts")).toBe("payments");
    expect(domainFromFilename("src/routes/app.tsx")).toBeUndefined();
    expect(domainFromFilename(undefined)).toBeUndefined();
  });

  it("returns the handler result unchanged and exposes the request ID inside the call", async () => {
    let seen: string | undefined;
    const result = await runServerFnBoundary(meta, async () => {
      seen = currentRequestId();
      return { ok: true };
    });
    expect(result).toEqual({ ok: true });
    expect(isRequestId(seen)).toBe(true);
    expect(currentRequestId()).toBeUndefined();
  });

  it("replaces an unexpected failure with a public error: no stack, SQL, table or constraint", async () => {
    const { lines, restore } = captureLogs();
    const dbError = new Error(
      'createOrder: duplicate key value violates unique constraint "uniq_orders_idempotency_key_per_org" on table "orders" (SUPABASE_SERVICE_ROLE_KEY)',
    );
    let thrown: unknown;
    try {
      await runServerFnBoundary(meta, async () => {
        throw dbError;
      });
    } catch (error) {
      thrown = error;
    }
    restore();

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message.startsWith(INTERNAL_ERROR_MESSAGE)).toBe(true);
    for (const leak of [
      "duplicate key",
      "uniq_orders",
      "orders",
      "SUPABASE",
      "createOrder",
      " at ",
    ]) {
      expect({ leak, found: message.includes(leak) }).toEqual({ leak, found: false });
    }
    // Only the message crosses the wire — and the stack of the public error
    // is a fresh one that never names the failing query.
    expect((thrown as Error).stack ?? "").not.toContain("duplicate key");

    // The support reference in the message is the requestId of the log line.
    const reference = supportReferenceOf(thrown);
    expect(isRequestId(reference)).toBe(true);
    const logged = lines.find((l) => l.record["event"] === "server_fn.unexpected_error");
    expect(logged?.record).toMatchObject({
      level: "error",
      requestId: reference,
      domain: "orders",
      operation: "createOrderFn",
      retryable: true,
    });
  });

  it("passes domain errors through with their exact, service-authored message", async () => {
    const { lines, restore } = captureLogs();
    const cases = [
      Object.assign(new Error("Missing permission: orders.create"), { statusCode: 403 }),
      Object.assign(
        new Error("This idempotency key was already used for a different order request"),
        { statusCode: 409, code: "idempotency_conflict" },
      ),
      Object.assign(new Error("Cannot move order lifecycle from 'completed' to 'draft'"), {
        statusCode: 409,
      }),
      Object.assign(new Error("Customer not found"), { statusCode: 404 }),
      new RateLimitedError(30),
    ];
    for (const domainError of cases) {
      let thrown: unknown;
      try {
        await runServerFnBoundary(meta, async () => {
          throw domainError;
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(domainError);
    }
    restore();
    // Expected outcomes are logged without their message text.
    for (const line of lines) {
      expect(line.record["event"]).toBe("server_fn.rejected");
      expect(line.record["errorMessage"]).toBeUndefined();
    }
  });

  it("passes caller validation errors (ZodError) through", async () => {
    const zodError = (() => {
      try {
        z.object({ orderId: z.string().uuid() }).parse({ orderId: "nope" });
      } catch (error) {
        return error;
      }
    })();
    await expect(
      runServerFnBoundary(meta, async () => {
        throw zodError;
      }),
    ).rejects.toBe(zodError);
  });

  it("does NOT treat a provider error's `status` as a public domain error", () => {
    const providerError = Object.assign(new Error("Database error saving new user"), {
      status: 500,
      name: "AuthApiError",
    });
    expect(isPublicDomainError(providerError)).toBe(false);
    const postgrestLike = Object.assign(new Error('relation "x" does not exist'), { status: 400 });
    expect(isPublicDomainError(postgrestLike)).toBe(false);
  });

  it("lets TanStack control flow (Response / redirect / notFound) through untouched", async () => {
    const response = new Response(null, { status: 302 });
    await expect(
      runServerFnBoundary(meta, async () => {
        throw response;
      }),
    ).rejects.toBe(response);
    const notFound = { isNotFound: true };
    await expect(
      runServerFnBoundary(meta, async () => {
        throw notFound;
      }),
    ).rejects.toBe(notFound);
  });

  it("nested server-function calls share one request ID and one log line", async () => {
    const { lines, restore } = captureLogs();
    const ids: Array<string | undefined> = [];
    await expect(
      runServerFnBoundary(meta, async () => {
        ids.push(currentRequestId());
        await runServerFnBoundary(
          { name: "getSessionFn", filename: "src/api/auth.ts" },
          async () => {
            ids.push(currentRequestId());
            throw new Error("inner db failure");
          },
        );
      }),
    ).rejects.toThrow(INTERNAL_ERROR_MESSAGE);
    restore();
    expect(ids[0]).toBe(ids[1]);
    expect(lines.filter((l) => l.record["event"] === "server_fn.unexpected_error")).toHaveLength(1);
  });

  it("is installed globally for every server function", () => {
    const start = read("src/start.ts");
    expect(start).toContain("functionMiddleware: [serverFnBoundary]");
    expect(start).toContain('await import("./server/observability/server-fn-boundary")');
  });
});

// ── Public error shape in the browser ───────────────────────────────────────

describe("public error shape", () => {
  const internal = new Error(formatInternalErrorMessage("req_0123456789abcdef0123"));

  it("carries a parseable support reference and nothing else", () => {
    expect(supportReferenceOf(internal)).toBe("req_0123456789abcdef0123");
    expect(supportReferenceOf(new Error("Customer not found"))).toBeNull();
    expect(supportReferenceOf("not an error")).toBeNull();
  });

  it("recognises a rate-limit refusal without leaking its rule or bucket", () => {
    const limited = new RateLimitedError(42);
    expect(isRateLimitedError(new Error(limited.message))).toBe(true);
    expect(limited.statusCode).toBe(429);
    expect(limited.message).toContain("42 seconds");
    expect(limited.message).not.toMatch(/orders\.create|bucket|member|organization/);
    expect(isRateLimitedError(internal)).toBe(false);
  });

  it("every UI classifier reads the sanitized message as a generic failure, never a domain outcome", () => {
    // Only the message survives the wire, so classify a bare Error with it.
    const wire = new Error(internal.message);
    expect(classifyOrderError(wire)).toBe("server_error");
    expect(classifyPaymentError(wire)).toBe("server_error");
    expect(classifyCustomerError(wire)).toBe("error");
    expect(classifyCatalogError(wire)).toBe("generic");
    expect(classifyInventoryError(wire)).toBe("generic");
    expect(classifyDeliveryError(wire)).toBe("server_error");
    const limited = new Error(new RateLimitedError(10).message);
    expect(classifyOrderError(limited)).toBe("server_error");
    expect(classifyPaymentError(limited)).toBe("server_error");
  });

  it("the audit-blocked refusal is public, classifiable and carries no database text", () => {
    const audit = read("src/server/auth/audit.ts");
    expect(audit).toContain('{ statusCode: 503, code: "audit_unavailable" }');
    expect(audit).not.toContain("audit trail. (${msg})");
    const wire = new Error(
      "Audit record could not be persisted for action 'inventory.adjust'. The operation was blocked to preserve the audit trail.",
    );
    expect(classifyInventoryError(wire)).toBe("audit_blocked");
  });
});
