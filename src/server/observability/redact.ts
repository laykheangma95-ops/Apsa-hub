/**
 * Log redaction — the one place that decides what may leave the process in a
 * log line or an error report.
 *
 * Two layers, both always applied:
 *
 *   1. KEY-based: any field whose name says it carries a secret, a credential
 *      or customer PII is replaced wholesale with "[REDACTED]", whatever its
 *      value looks like. The value is never inspected, never truncated, never
 *      hashed into the log.
 *   2. VALUE-based: every remaining string is scrubbed of things that look like
 *      credentials or contact details even when they arrive under an innocent
 *      key (a PostgREST message quoting `Key (email)=(a@b.c)`, a JWT pasted into
 *      a reason field, a phone number inside an error message, "password:
 *      hunter2" inside a message, a short webhook secret after a `secret=`
 *      label, a Cookie/Authorization header line, a known provider token
 *      format, a street address or Cambodian sangkat/khan/phum place name).
 *
 * Free-form content keys (message, body, content, text, payload, raw, note,
 * comment, caption, …) are redacted wholesale by layer 1: conversation
 * messages and provider payloads are never logged, even scrubbed. The
 * operational `errorMessage` field is the one deliberate exception — it is an
 * Error's scrubbed message, capped at 300 characters.
 *
 * The contract is "prefer IDs and codes over payloads". This module is the
 * backstop for when a payload slips through anyway — it is not a licence to
 * log payloads.
 *
 * Pure and dependency-free: safe to import from any server module and from
 * tests. Never imported by browser code (nothing here is browser-relevant).
 */

export const REDACTED = "[REDACTED]";

/**
 * Field names whose values are never logged. Matched case-insensitively
 * against the whole key AND against each `_`/`-`/camelCase segment, so
 * `refresh_token`, `refreshToken`, `x-api-key` and `customerPhone` all match.
 */
const SENSITIVE_KEY_PARTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "cookie",
  "authorization",
  "auth",
  "apikey",
  "key",
  "otp",
  "credential",
  "session",
  "signature",
  "email",
  "phone",
  "address",
  "card",
  "pan",
  "cvv",
  "iban",
  "account",
  "body",
  "content",
  "message_text",
  "text",
  "note",
  "name",
  // Free-form customer/provider content under generic keys: a conversation
  // message, a webhook payload, a raw provider response. Never logged.
  "message",
  "msg",
  "payload",
  "raw",
  "caption",
  "comment",
  "transcript",
  "snippet",
  "preview",
  "street",
  "pin",
  "pwd",
] as const;

/**
 * Keys that contain a sensitive segment but are known-safe identifiers or
 * operational fields. Checked before SENSITIVE_KEY_PARTS.
 */
const SAFE_KEYS = new Set([
  "requestid",
  "organizationid",
  "userid",
  "actoruserid",
  "orderid",
  "paymentid",
  "deliveryid",
  "customerid",
  "variantid",
  "productid",
  "eventid",
  "operation",
  "domain",
  "event",
  "level",
  "ts",
  "errorclass",
  "errorcode",
  "code",
  "status",
  "statuscode",
  "retryable",
  "rule",
  "ruleid",
  "backend",
  "provider",
  "reason",
  "count",
  "limit",
  "windowseconds",
  "retryafterseconds",
  "durationms",
  "action",
  "resourcetype",
  "idempotencykeypresent",
  "stack",
  "errormessage",
  "degraded",
  "servername",
  "filename",
]);

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SAFE_KEYS.has(compact)) return false;
  const segments = keySegments(key);
  return SENSITIVE_KEY_PARTS.some(
    (part) => compact === part.replace(/_/g, "") || segments.includes(part),
  );
}

// ── Value scrubbing ───────────────────────────────────────────────────────────

/**
 * Labels that announce a credential in free text. "password: hunter2",
 * "webhook_secret=abc", "api-key \"k1\"", "token: t" — the VALUE is redacted
 * whatever its length, because short secrets are still secrets.
 */
const CREDENTIAL_LABEL =
  "(?:password|passwd|pwd|passcode|pin|otp|secret|client[_-]?secret|webhook[_-]?secret|signing[_-]?secret|app[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|bot[_-]?token|api[_-]?key|apikey|private[_-]?key|service[_-]?role(?:[_-]?key)?|credentials?)";

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // Cookie / Set-Cookie / Authorization header lines: everything after the
  // label to the end of the line is credential material.
  [
    /\b(set-cookie|cookie|proxy-authorization|authorization)(\s*[:=]\s*)[^\r\n]+/gi,
    "$1$2[REDACTED]",
  ],
  // label: value / label=value / "label": "value" credential pairs, any length.
  [
    new RegExp(
      `(["']?\\b${CREDENTIAL_LABEL}\\b["']?)(\\s*[:=]\\s*|\\s+is\\s+)("[^"]*"|'[^']*'|[^\\s,;&"'}\\]]+)`,
      "gi",
    ),
    "$1$2[REDACTED]",
  ],
  // Known token formats that may appear with no label at all.
  [
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b|\bwhsec_[A-Za-z0-9+/=]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|\bsbp_[A-Za-z0-9]{20,}\b|\bEAA[A-Za-z0-9]{20,}\b|\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,
    "[REDACTED_TOKEN]",
  ],
  // JWTs (Supabase access/refresh tokens, provider tokens).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED_JWT]"],
  // Authorization header values.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
  // Card-like digit runs (13–19 digits, optional spaces/dashes).
  [/\b(?:\d[ -]?){12,18}\d\b/g, "[REDACTED_NUMBER]"],
  // Phone-like runs: optional +, 8–15 digits with separators. Runs after the
  // card pattern so a card number is not half-matched as a phone.
  [/(?<![\w-])\+?\d(?:[\s.-]?\d){7,14}(?![\w-])/g, "[REDACTED_PHONE]"],
  // key=value credentials in URLs / DSNs / query strings.
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|apikey)=([^&\s"']+)/gi,
    "$1=[REDACTED]",
  ],
  // Long opaque secrets (service keys, webhook secrets): 40+ chars of base64/hex.
  [/\b[A-Za-z0-9_+/=-]{40,}\b/g, "[REDACTED_SECRET]"],
  // Street addresses in customer content: "#12, St. 271", "No. 5 Street 63",
  // "Road 2004", Khmer "ផ្ទះលេខ ១២ ផ្លូវ ២៧១". Conservative: a street keyword
  // must be followed by a number, so prose like "street food" is untouched.
  [
    /(?:(?:#|\bno\.?\s*|\bhouse\s*)\s*\d+[A-Za-z]?\s*,?\s*)?\b(?:st\.?|street|road|rd\.?|blvd\.?|boulevard)\s*#?\d+[A-Za-z]?\b/gi,
    "[REDACTED_ADDRESS]",
  ],
  [/(?:ផ្ទះ(?:លេខ)?|ផ្លូវ(?:លេខ)?)\s*[#]?[0-9០-៩]+[A-Za-z]?/g, "[REDACTED_ADDRESS]"],
  // Cambodian administrative place names that follow a customer's address:
  // "Sangkat Boeung Keng Kang", "Khan Chamkarmon", "Phum Thmey", Khmer
  // សង្កាត់/ខណ្ឌ/ភូមិ/ឃុំ. The keyword and the next word are redacted.
  [
    /\b(?:[Ss]angkat|[Kk]han|[Pp]hum|[Kk]rong)\s+[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,2}/g,
    "[REDACTED_ADDRESS]",
  ],
  [/(?:សង្កាត់|ខណ្ឌ|ភូមិ|ឃុំ|ក្រុង|ស្រុក)\s*[^\s,;.]+/g, "[REDACTED_ADDRESS]"],
];

/**
 * UUIDs are identifiers and ISO dates are timestamps, not secrets or phone
 * numbers — both are protected from the value patterns.
 */
const PARKED_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gi;

export const MAX_LOGGED_STRING_LENGTH = 500;

export function scrubString(value: string, maxLength = MAX_LOGGED_STRING_LENGTH): string {
  // Park identifiers so the digit/secret patterns never eat them.
  const parked: string[] = [];
  let out = value.replace(PARKED_RE, (match) => {
    parked.push(match);
    return `\uE000${parked.length - 1}\uE000`;
  });
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(/\uE000(\d+)\uE000/g, (_, index: string) => parked[Number(index)] ?? "");
  return out.length > maxLength ? `${out.slice(0, maxLength)}…[truncated]` : out;
}

// ── Structured redaction ──────────────────────────────────────────────────────

const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;

/**
 * Deep-redacts a value for logging. Objects are copied, never mutated.
 * Functions and symbols are dropped; Errors become { name, message } with the
 * message scrubbed; cycles and over-deep nesting are cut.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message) };
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    const redacted = redact(inner, depth + 1, seen);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}

/** Redacts a flat field bag, keeping the object shape for JSON logging. */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redact(fields) as Record<string, unknown>;
}
