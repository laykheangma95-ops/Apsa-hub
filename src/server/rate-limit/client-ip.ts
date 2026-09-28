/**
 * Client IP for rate-limit keys — a SECONDARY signal only.
 *
 * Forwarding headers are only as trustworthy as the proxy in front of the app:
 * Cloudflare sets `cf-connecting-ip`, Vercel overwrites `x-forwarded-for` /
 * `x-real-ip` at its edge, but a server reachable directly accepts whatever a
 * client sends. So:
 *   - NO forwarding header is trusted by default. Only when the operator sets
 *     RATE_LIMIT_CLIENT_IP_HEADER to the ONE header the deployment's proxy
 *     overwrites is that header read; `x-forwarded-for`, `x-real-ip` and
 *     `cf-connecting-ip` are otherwise ignored for security decisions and the
 *     client IP is "unknown" (docs/OPERABILITY.md §4 — deployment requirement);
 *   - every auth limit that has an IP bucket also has an identity- or
 *     token-derived bucket (email digest, recovery-session digest, link-token
 *     digest) that does not depend on headers at all, so a missing or spoofed
 *     IP never removes meaningful protection;
 *   - when no usable IP is found the IP bucket is SKIPPED, never collapsed into
 *     one shared "unknown" bucket (which would let one abuser lock everyone
 *     out).
 * IPv6 addresses are keyed by their /64 prefix — one subscriber usually holds a
 * whole /64, so rotating the low bits must not buy a fresh bucket.
 *
 * The IP is only ever an input to the HMAC bucket key; it is not stored or
 * logged.
 *
 * Server-only.
 */

type HeaderGetter = (name: string) => string | null | undefined;

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_CHARS_RE = /^[0-9a-f:]{2,39}$/i;

function expandIpv6(address: string): string[] | null {
  if (!IPV6_CHARS_RE.test(address)) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => g.toLowerCase().padStart(4, "0"));
}

/** A normalized bucket subject for an IP, or null when the value is not an IP. */
export function normalizeClientIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().replace(/^\[|\]$/g, "");
  if (IPV4_RE.test(value)) return value;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is the IPv4 client.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped?.[1] && IPV4_RE.test(mapped[1])) return mapped[1];
  const groups = expandIpv6(value);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : null;
}

export function clientIpFromHeaders(
  getHeader: HeaderGetter,
  trustedHeader: string | undefined = process.env["RATE_LIMIT_CLIENT_IP_HEADER"],
): string | null {
  // Not configured → no header is trusted: the IP is unknown.
  const name = trustedHeader?.trim().toLowerCase();
  if (!name) return null;
  const raw = getHeader(name);
  if (!raw) return null;
  // x-forwarded-for: "client, proxy1, proxy2" — the left-most is the client
  // as seen by the first proxy (only meaningful when that proxy overwrites it).
  const first = name === "x-forwarded-for" ? raw.split(",")[0] : raw;
  return normalizeClientIp(first);
}

/**
 * The current request's client IP, or null outside a request / when unknown.
 * Never throws: rate limiting must not break a request it cannot key by IP.
 */
export async function currentClientIp(): Promise<string | null> {
  try {
    const server = (await import("@tanstack/react-start/server")) as {
      getRequestHeader?: (name: string) => string | undefined;
    };
    if (typeof server.getRequestHeader !== "function") return null;
    const getRequestHeader = server.getRequestHeader;
    return clientIpFromHeaders((name) => getRequestHeader(name));
  } catch {
    return null;
  }
}
