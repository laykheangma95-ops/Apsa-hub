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
 * ── ROUTING: AUTHORITATIVE DOMAIN, BOUNDED FAN-OUT ───────────────────────────
 *
 * Each shape goes to the domain that OWNS that kind of record, and does not
 * get sprayed across every backend that might coincidentally match it:
 *
 *   order code       -> Orders        (never Delivery: an order with no
 *                                      delivery row still exists, and finding
 *                                      it through the delivery list was the
 *                                      workaround this replaces)
 *   customer phone   -> Customers     (and only when the member may search by
 *                                      phone — see lookup.ts)
 *   customer name    -> Customers, plus Delivery, because a delivery legitimately
 *                      records a customer name and a courier name is also just
 *                      letters; two targeted probes, not a broadcast
 *   tracking number  -> Delivery
 *   barcode / SKU    -> Catalog
 *   UUID             -> the four id probes, one per domain that uses UUID keys
 *
 * The phone and name shapes were previously answered with an `unsupported`
 * note, because APSA had no server-side customer search. It has one now
 * (src/server/customers/service.ts), so the note is gone and the search is
 * real — but the permission rule replacing it is stricter, not looser: a phone
 * probe is withheld outright from a member without customers.view_sensitive,
 * so no phone query is issued rather than issued and masked.
 *
 * Safe to bundle for the browser: pure string work over two pure modules.
 */
import {
  looksLikeCustomerPhoneQuery,
  normalizeCustomerNameQuery,
  toAsciiDigitScript,
} from "@/lib/customer-search";
import { looksLikeOrderCode, normalizeOrderCode } from "@/lib/order-code";

/** One concrete lookup against one domain. */
export type ApsiProbe =
  | { kind: "order-by-id"; id: string }
  | { kind: "order-by-code"; value: string }
  | { kind: "payment-by-id"; id: string }
  | { kind: "delivery-by-id"; id: string }
  | { kind: "customer-by-id"; id: string }
  | { kind: "customer-by-name"; value: string }
  | { kind: "customer-by-phone"; value: string }
  | { kind: "product-by-barcode"; value: string }
  | { kind: "product-by-sku"; value: string }
  | { kind: "delivery-search"; value: string };

export type ApsiProbeKind = ApsiProbe["kind"];

export interface ApsiQueryPlan {
  /** Exactly what the member typed, untouched. */
  raw: string;
  /** Trimmed and whitespace-collapsed. Empty when there is nothing to look up. */
  normalized: string;
  /** True when the input carries no searchable characters at all. */
  empty: boolean;
  probes: readonly ApsiProbe[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest input any of the underlying validators will accept. */
export const APSI_QUERY_MAX_LENGTH = 100;

/** Exact-match identifier lookups need a single token, not a phrase. */
const SINGLE_TOKEN_RE = /^[\w.\-/]{2,}$/;

export function normalizeApsiQuery(raw: string): string {
  return toAsciiDigitScript(raw).replace(/\s+/g, " ").trim();
}

/**
 * Whether this reads as a phone number rather than a code.
 *
 * One definition, shared with the server that answers the query
 * (src/lib/customer-search.ts). If the console and the Customer service
 * disagreed about what a phone number looks like, the console would route a
 * query one way and the server would answer it another.
 */
export function looksLikePhoneNumber(normalized: string): boolean {
  return looksLikeCustomerPhoneQuery(normalized);
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
    return { raw, normalized: "", empty: true, probes: [] };
  }

  const probes: ApsiProbe[] = [];

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
    return { raw, normalized, empty: false, probes };
  }

  /*
   * An order code names exactly one order, and Orders is the domain that owns
   * it. Nothing else runs: a code is not a SKU, not a barcode and not a
   * tracking number, so every other probe could only ever answer "no" — and a
   * "no" from a domain that was never going to know is what made the old
   * delivery-search path read as "this order does not exist".
   */
  const orderCode = normalizeOrderCode(normalized);
  if (looksLikeOrderCode(orderCode)) {
    probes.push({ kind: "order-by-code", value: orderCode });
    return { raw, normalized, empty: false, probes };
  }

  /*
   * A phone number goes to Customers and nowhere else. It is not a tracking
   * number, and running the delivery search for it as well would put a
   * customer's phone number into a second domain's query for no answer it
   * could give.
   */
  if (looksLikePhoneNumber(normalized)) {
    probes.push({ kind: "customer-by-phone", value: normalized });
    return { raw, normalized, empty: false, probes };
  }

  if (looksLikePersonName(normalized)) {
    probes.push({ kind: "customer-by-name", value: normalizeCustomerNameQuery(normalized) });
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
   * The Delivery domain's own free-text search: order code, courier name,
   * tracking number and customer name across the complete latest-per-order
   * set. Still the right home for a tracking reference or a courier name.
   */
  probes.push({ kind: "delivery-search", value: normalized });

  return { raw, normalized, empty: false, probes };
}

/**
 * Which "nothing matched" sentence this query has earned.
 *
 * A not-found line is a claim about what APSA holds, and its scope must match
 * the scope of what was actually searched. An order code was looked up in
 * Orders and nowhere else, so the only honest thing to say is that no order
 * carries that code — never that nothing in APSA matches it, which is a claim
 * no single-domain probe is entitled to make.
 *
 * Returns an i18n key suffix; the console prefixes it with "apsi.empty.".
 */
export function apsiEmptyScope(
  plan: ApsiQueryPlan,
): "orderCode" | "customerPhone" | "customerName" | "identifier" | "search" {
  const kinds = new Set(plan.probes.map((probe) => probe.kind));
  if (kinds.has("order-by-code")) return "orderCode";
  if (kinds.has("customer-by-phone")) return "customerPhone";
  if (kinds.has("customer-by-name")) return "customerName";
  if (kinds.has("order-by-id")) return "identifier";
  return "search";
}
