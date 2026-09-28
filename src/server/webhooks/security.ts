/**
 * Webhook security primitives — provider-neutral, for FUTURE provider routes.
 *
 * No provider webhook is exposed by APSA today (Telegram, Meta and payment
 * providers are separate workstreams). This module is the reusable boundary
 * those routes will stand on, so each provider only supplies how ITS
 * signature, timestamp and event ID are read — never its own crypto,
 * comparison or replay logic.
 *
 * verifyWebhookRequest() runs, in this order, and stops at the first failure:
 *
 *   1. method        — POST only                                   → 405
 *   2. rate limit    — per provider + client IP, before any work   → 429
 *   3. raw body      — read ONCE as exact bytes, bounded           → 413
 *                      (signatures are computed over the raw bytes; parsing
 *                      and re-serializing JSON would break them)
 *   4. signature     — provider-supplied check, constant-time      → 401
 *   5. timestamp     — within tolerance (default ±300 s), if the
 *                      provider signs one                          → 401
 *   6. event ID      — present and bounded                         → 400
 *   7. replay claim  — first sight of (provider, event ID) wins;
 *                      a repeat is { ok: true, duplicate: true }
 *                      and must be acknowledged, NOT processed
 *
 * Rejections are generic (webhookRejection()): the response never says which
 * check failed, what signature was expected, or anything about the secret.
 * The reason is logged server-side as a code.
 *
 * Server-only.
 */
import { serverLog } from "@/server/observability/logger";
import { checkRateLimits } from "@/server/rate-limit/limiter";
import { RATE_LIMITS } from "@/server/rate-limit/policies";
import type { WebhookReceiptStore } from "./receipts";

// ── Encoding helpers ──────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function toBytes(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ── Constant-time comparison ──────────────────────────────────────────────────

/**
 * Compares two strings without an early exit on the first differing byte, so
 * response timing does not reveal how much of a guessed signature was right.
 * A length mismatch still walks the full expected length before failing.
 */
export function timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const left = toBytes(a);
  const right = toBytes(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

// ── HMAC signatures ───────────────────────────────────────────────────────────

export type HmacAlgorithm = "SHA-256" | "SHA-1" | "SHA-512";
export type SignatureEncoding = "hex" | "base64";

export async function computeHmac(
  secret: string | Uint8Array,
  payload: string | Uint8Array,
  algorithm: HmacAlgorithm = "SHA-256",
  encoding: SignatureEncoding = "hex",
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toBytes(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, toBytes(payload)));
  return encoding === "hex" ? toHex(signature) : toBase64(signature);
}

export interface HmacVerification {
  /** Provider signing secret. Never logged, never echoed. */
  secret: string | Uint8Array;
  /** The EXACT bytes that were signed — the raw request body (plus any prefix the provider defines). */
  payload: string | Uint8Array;
  /** The signature the request carried, as sent. */
  signature: string | null | undefined;
  algorithm?: HmacAlgorithm;
  encoding?: SignatureEncoding;
  /** Scheme prefix the provider puts before the digest, e.g. "sha256=". */
  prefix?: string;
}

export async function verifyHmacSignature(input: HmacVerification): Promise<boolean> {
  const { signature, prefix = "" } = input;
  if (typeof signature !== "string" || signature.length === 0 || signature.length > 1024) {
    return false;
  }
  if (prefix && !signature.startsWith(prefix)) return false;
  const provided = signature.slice(prefix.length);
  const encoding = input.encoding ?? "hex";
  const expected = await computeHmac(input.secret, input.payload, input.algorithm, encoding);
  // Hex digests compare case-insensitively; base64 is case-sensitive.
  return timingSafeEqual(encoding === "hex" ? provided.toLowerCase() : provided, expected);
}

/**
 * Shared-secret header check (providers that send a static secret instead of
 * signing the body, e.g. a secret-token header). Constant-time; an empty or
 * missing configured secret never matches.
 */
export function verifySharedSecret(
  expected: string | undefined,
  provided: string | null | undefined,
): boolean {
  if (!expected || typeof provided !== "string" || provided.length === 0) return false;
  return timingSafeEqual(provided, expected);
}

// ── Timestamp tolerance ───────────────────────────────────────────────────────

export const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;

export type TimestampCheck = "ok" | "invalid" | "too_old" | "in_future";

/**
 * A signed timestamp bounds how long a captured request stays replayable.
 * `timestampSeconds` is the provider's Unix time in seconds.
 */
export function checkTimestampTolerance(
  timestampSeconds: number | string | null | undefined,
  nowMs: number = Date.now(),
  toleranceSeconds: number = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
): TimestampCheck {
  const value =
    typeof timestampSeconds === "string" && /^\d{1,12}$/.test(timestampSeconds.trim())
      ? Number(timestampSeconds.trim())
      : timestampSeconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "invalid";
  const deltaSeconds = nowMs / 1000 - value;
  if (deltaSeconds > toleranceSeconds) return "too_old";
  if (deltaSeconds < -toleranceSeconds) return "in_future";
  return "ok";
}

// ── Raw body ──────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export class WebhookBodyTooLargeError extends Error {
  constructor() {
    super("webhook body too large");
    this.name = "WebhookBodyTooLargeError";
  }
}

/**
 * Reads the request body once, as the exact bytes received, refusing to buffer
 * more than `maxBytes` (checked against Content-Length up front AND while
 * streaming, since the header can lie or be absent).
 */
export async function readRawBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_WEBHOOK_BODY_BYTES,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new WebhookBodyTooLargeError();
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new WebhookBodyTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface WebhookProviderSpec {
  /** Lowercase provider id, e.g. "telegram". Matches webhook_event_receipts.provider. */
  provider: string;
  maxBodyBytes?: number;
  /** Provider-specific signature check over the RAW body. Must use the primitives above. */
  verifySignature(rawBody: Uint8Array, headers: Headers): Promise<boolean> | boolean;
  /** The signed timestamp (Unix seconds), when the provider signs one. */
  signedTimestamp?(rawBody: Uint8Array, headers: Headers): number | string | null | undefined;
  toleranceSeconds?: number;
  /** The provider's unique event/update ID — read only AFTER the signature passed. */
  eventId(rawBody: Uint8Array, headers: Headers): string | null | undefined;
}

export type WebhookRejectReason =
  | "method_not_allowed"
  | "rate_limited"
  | "body_too_large"
  | "bad_signature"
  | "stale_timestamp"
  | "missing_event_id";

export type WebhookVerification =
  | { ok: true; duplicate: false; eventId: string; rawBody: Uint8Array }
  | { ok: true; duplicate: true; eventId: string }
  | { ok: false; status: number; reason: WebhookRejectReason };

const REJECT_STATUS: Record<WebhookRejectReason, number> = {
  method_not_allowed: 405,
  rate_limited: 429,
  body_too_large: 413,
  bad_signature: 401,
  stale_timestamp: 401,
  missing_event_id: 400,
};

function reject(
  provider: string,
  reason: WebhookRejectReason,
): { ok: false; status: number; reason: WebhookRejectReason } {
  serverLog.warn("webhook.rejected", { provider, reason });
  return { ok: false, status: REJECT_STATUS[reason], reason };
}

export interface VerifyWebhookOptions {
  receipts: WebhookReceiptStore;
  /** Client IP for the rate-limit bucket; null skips the IP bucket. */
  clientIp: string | null;
  nowMs?: number;
}

export async function verifyWebhookRequest(
  request: Request,
  spec: WebhookProviderSpec,
  options: VerifyWebhookOptions,
): Promise<WebhookVerification> {
  const { provider } = spec;
  if (request.method !== "POST") return reject(provider, "method_not_allowed");

  const limit = await checkRateLimits(
    [{ rule: RATE_LIMITS.webhookIp, parts: [provider, options.clientIp] }],
    options.nowMs,
  );
  if (!limit.allowed) return reject(provider, "rate_limited");

  let rawBody: Uint8Array;
  try {
    rawBody = await readRawBody(request, spec.maxBodyBytes);
  } catch (error) {
    if (error instanceof WebhookBodyTooLargeError) return reject(provider, "body_too_large");
    throw error;
  }

  let signatureOk = false;
  try {
    signatureOk = await spec.verifySignature(rawBody, request.headers);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return reject(provider, "bad_signature");

  if (spec.signedTimestamp) {
    const check = checkTimestampTolerance(
      spec.signedTimestamp(rawBody, request.headers),
      options.nowMs,
      spec.toleranceSeconds,
    );
    if (check !== "ok") return reject(provider, "stale_timestamp");
  }

  const rawEventId = spec.eventId(rawBody, request.headers);
  const eventId = typeof rawEventId === "string" ? rawEventId.trim() : "";
  if (!eventId || eventId.length > 200) return reject(provider, "missing_event_id");

  const firstSight = await options.receipts.claim(provider, eventId);
  if (!firstSight) {
    serverLog.info("webhook.duplicate", { provider });
    return { ok: true, duplicate: true, eventId };
  }
  return { ok: true, duplicate: false, eventId, rawBody };
}

/**
 * The response for any rejected webhook. Identical body for every reason — a
 * caller probing the endpoint learns only the status class.
 */
export function webhookRejection(status: number): Response {
  return new Response(JSON.stringify({ ok: false }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
