/**
 * Client IP for rate-limit keys — a SECONDARY signal only.
 *
 * Forwarding headers are only as trustworthy as the proxy in front of the app:
 * Cloudflare sets `cf-connecting-ip`, Vercel overwrites `x-forwarded-for` /
 * `x-real-ip` at its edge, but a server reachable directly accepts whatever a
 * client sends. So:
 *   - every IP-keyed limit is paired with an identity-keyed one (email digest,
 *     member, organization) that does not depend on headers at all;
 *   - RATE_LIMIT_CLIENT_IP_HEADER pins the ONE header the deployment's proxy
 *     guarantees, when the operator sets it;
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

const DEFAULT_HEADER_ORDER = ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"] as const;

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
  const names = trustedHeader ? [trustedHeader.toLowerCase()] : DEFAULT_HEADER_ORDER;
  for (const name of names) {
    const raw = getHeader(name);
    if (!raw) continue;
    // x-forwarded-for: "client, proxy1, proxy2" — the left-most is the client
    // as seen by the first proxy.
    const first = name === "x-forwarded-for" ? raw.split(",")[0] : raw;
    const ip = normalizeClientIp(first);
    if (ip) return ip;
  }
  return null;
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
