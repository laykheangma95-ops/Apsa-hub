/**
 * Apsi's deterministic input classifier.
 *
 * DETERMINISTIC BEFORE AI is a hard rule for the service console: a structured
 * identifier — a UUID, a SKU, a barcode, a tracking number, an order code —
 * must go straight to the domain that owns it, never through any inference
 * path. This module is that decision, written as a pure function so it can be
 * tested exhaustively without a network, a session or a React tree.
 *
 * It decides only WHICH lookups are worth running. It does not decide WHETHER
 * the member may run them (that is `planApsiLookup`'s capability filter, and
 * the server's own `ctx.require` after it), and it never decides what is true
 * (the domains do).
 *
 * Just as important is what it refuses to promise. APSA has no server-side
 * customer search by phone or by name today, so an input that looks like a
 * phone number produces an explicit `unsupported` note rather than a search
 * that quietly finds nothing and reads as "this customer does not exist".
 *
 * Safe to bundle for the browser: pure string work, no imports.
 */

/** One concrete lookup against one domain. */
export type ApsiProbe =
  | { kind: "order-by-id"; id: string }
  | { kind: "payment-by-id"; id: string }
  | { kind: "delivery-by-id"; id: string }
  | { kind: "customer-by-id"; id: string }
  | { kind: "product-by-barcode"; value: string }
  | { kind: "product-by-sku"; value: string }
  | { kind: "delivery-search"; value: string };

export type ApsiProbeKind = ApsiProbe["kind"];

/**
 * A capability APSA does not have a backend contract for yet. Surfaced to the
 * member verbatim — never silently swallowed, and never faked.
 */
export type ApsiUnsupported = "customer-phone-search" | "customer-name-search";

export interface ApsiQueryPlan {
  /** Exactly what the member typed, untouched. */
  raw: string;
  /** Trimmed and whitespace-collapsed. Empty when there is nothing to look up. */
  normalized: string;
  /** True when the input carries no searchable characters at all. */
  empty: boolean;
  probes: readonly ApsiProbe[];
  unsupported: readonly ApsiUnsupported[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest input any of the underlying validators will accept. */
export const APSI_QUERY_MAX_LENGTH = 100;

/** Exact-match identifier lookups need a single token, not a phrase. */
const SINGLE_TOKEN_RE = /^[\w.\-/]{2,}$/;

/**
 * Cambodian mobile numbers as they are actually typed into a phone: local
 * (0XX XXX XXX / 0XX XXX XXXX) or international (+855 ...), with any mix of
 * spaces, dots and dashes. Khmer digits normalise first so ០១២ counts too.
 */
const KHMER_DIGITS = "០១២៣៤៥៦៧៨៩";

function toAsciiDigits(value: string): string {
  let out = "";
  for (const ch of value) {
    const khmer = KHMER_DIGITS.indexOf(ch);
    out += khmer >= 0 ? String(khmer) : ch;
  }
  return out;
}

export function normalizeApsiQuery(raw: string): string {
  return toAsciiDigits(raw).replace(/\s+/g, " ").trim();
}

/**
 * Whether this reads as a phone number rather than a code.
 *
 * Deliberately narrow. A tracking number can also be a long digit string, so
 * this only claims "phone" for the shapes a Cambodian customer's number
 * actually takes — and being wrong here costs nothing but one extra honest
 * note, because the delivery search still runs either way.
 */
export function looksLikePhoneNumber(normalized: string): boolean {
  if (!/^\+?[\d\s.\-()]+$/.test(normalized)) return false;
  const digits = normalized.replace(/\D/g, "");
  if (normalized.startsWith("+855") || digits.startsWith("855")) {
    return digits.length >= 10 && digits.length <= 12;
  }
  if (digits.startsWith("0")) return digits.length >= 8 && digits.length <= 10;
  return false;
}

/** Word characters and at least one letter — a name, not a code. */
export function looksLikePersonName(normalized: string): boolean {
  if (/\d/.test(normalized)) return false;
  return /\p{L}/u.test(normalized);
}

/**
 * Turn raw input into the set of lookups worth running.
 *
 * Ordering inside `probes` is the order results are presented in, so the most
 * specific answer (an exact identifier) comes before the broadest one (the
 * delivery search).
 */
export function classifyApsiQuery(raw: string): ApsiQueryPlan {
  const normalized = normalizeApsiQuery(raw).slice(0, APSI_QUERY_MAX_LENGTH);

  if (normalized.length === 0) {
    return { raw, normalized: "", empty: true, probes: [], unsupported: [] };
  }

  const probes: ApsiProbe[] = [];
  const unsupported: ApsiUnsupported[] = [];

  if (UUID_RE.test(normalized)) {
    /*
     * A UUID carries no domain marker, so every domain that uses UUID primary
     * keys is a candidate. They run in parallel and the ones the member cannot
     * read are never issued at all — see planApsiLookup.
     */
    const id = normalized.toLowerCase();
    probes.push(
      { kind: "order-by-id", id },
      { kind: "payment-by-id", id },
      { kind: "delivery-by-id", id },
      { kind: "customer-by-id", id },
    );
    return { raw, normalized, empty: false, probes, unsupported };
  }

  /*
   * Exact identifier lookups only accept a single token: "coca cola" is a
   * product NAME, and there is no server-side product name search, so
   * pretending it is a SKU would turn a real "not found" into a wrong answer.
   */
  if (SINGLE_TOKEN_RE.test(normalized)) {
    probes.push(
      { kind: "product-by-barcode", value: normalized },
      { kind: "product-by-sku", value: normalized },
    );
  }

  /*
   * The delivery search is the one genuine free-text search APSA has today:
   * the server matches it against order code, courier name, tracking number
   * and customer name across the complete latest-per-order set — not against
   * the rows that happen to be on screen.
   */
  probes.push({ kind: "delivery-search", value: normalized });

  if (looksLikePhoneNumber(normalized)) unsupported.push("customer-phone-search");
  else if (looksLikePersonName(normalized)) unsupported.push("customer-name-search");

  return { raw, normalized, empty: false, probes, unsupported };
}
