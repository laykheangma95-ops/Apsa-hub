/**
 * Rate-limit bucket keys.
 *
 * A bucket key is HMAC-SHA256(pepper, ruleId ␀ part ␀ part …) in hex. The
 * parts are what the rule is scoped by — a normalized email, a client IP, an
 * organization ID + member ID — and none of them is ever stored or logged:
 * only the 64-hex digest reaches the database.
 *
 * The pepper makes the digest non-reversible by dictionary for anyone without
 * server secrets (a plain SHA-256 of an email can be confirmed by hashing a
 * guessed address). It is, in order:
 *   1. RATE_LIMIT_KEY_SECRET, when configured;
 *   2. otherwise derived from SUPABASE_SERVICE_ROLE_KEY (already a required
 *      server-only secret) — the key itself is never used directly;
 *   3. otherwise (local dev / tests with no server secrets) a fixed
 *      domain-separation constant — digests still carry no raw value.
 * Rotating the pepper simply starts every bucket afresh; nothing else depends
 * on it.
 *
 * Server-only.
 */

const FALLBACK_PEPPER = "apsa.rate-limit.v1.unpeppered";

let cachedPepper: { source: string; key: CryptoKey } | null = null;

function pepperSource(): string {
  const explicit = process.env["RATE_LIMIT_KEY_SECRET"];
  if (explicit) return `explicit:${explicit}`;
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (serviceKey) return `derived:apsa.rate-limit.v1:${serviceKey}`;
  return FALLBACK_PEPPER;
}

async function pepperKey(): Promise<CryptoKey> {
  const source = pepperSource();
  if (cachedPepper?.source === source) return cachedPepper.key;
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const key = await crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedPepper = { source, key };
  return key;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Normalizes an email the same way everywhere a limit is keyed by one. */
export function normalizeEmailForKey(email: string): string {
  return email.trim().toLowerCase();
}

export async function bucketKey(ruleId: string, parts: readonly string[]): Promise<string> {
  const payload = [ruleId, ...parts].join("\u0000");
  const signature = await crypto.subtle.sign(
    "HMAC",
    await pepperKey(),
    new TextEncoder().encode(payload),
  );
  return toHex(signature);
}
