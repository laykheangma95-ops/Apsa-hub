/**
 * The customer-search matching contract, written once.
 *
 * Two independent consumers need the SAME answer to "is this a phone number or
 * a name?": the Apsi console, which must decide whether to issue a phone
 * search AT ALL before it has permission to (src/lib/apsi/input.ts), and the
 * Customer service, which decides which column may participate in the query
 * (src/server/customers/service.ts). If those two disagreed, the console would
 * route a query one way and the server would answer it another — so the rule
 * lives here, as pure string work, and both import it.
 *
 * ── WHAT PHONE MATCHING ACTUALLY SUPPORTS ────────────────────────────────────
 *
 * APSA has NO stored phone normalization. `customers.primary_phone` is plain
 * TEXT (migration 011) written verbatim from whatever a merchant typed;
 * nothing in any migration, RPC or service rewrites it, and DATA_MODEL.md §144
 * ("store phone in normalized international format WHEN POSSIBLE", E.164) is a
 * stated intention with no implementation behind it. There is therefore no
 * data contract that says what country code a stored number carries, or
 * whether it carries one at all.
 *
 * So the matching rule is deliberately the smallest one that is true of the
 * values actually on disk:
 *
 *   DIGIT-SEQUENCE PREFIX MATCH. Both sides are reduced to ASCII digits —
 *   Khmer digits (០-៩) map to their ASCII equivalents, and every space, dot,
 *   dash, bracket and plus sign is dropped. A customer matches when the
 *   stored number's digit sequence STARTS WITH the query's digit sequence.
 *
 * What that means in practice, stated plainly because a merchant will hit it:
 *
 *   "012 345 678"  matches a customer stored as "012345678", "012-345-678",
 *                  "012 345 678" or "០១២៣៤៥៦៧៨" — separators and script
 *                  never change the answer.
 *   "01234567"     matches "012345678" — a prefix, so the picker narrows as
 *                  the merchant types the last digits.
 *   "012345678"    does NOT match a customer stored as "+855 12 345 678".
 *                  Those are the same human number, and APSA knows it is not
 *                  allowed to assume that: converting 0XX <-> +855XX is a
 *                  country-code rule, and inventing one here would silently
 *                  decide that two different stored strings are one person.
 *                  When a defined normalization contract exists (a generated
 *                  E.164 column, backfilled and indexed), THAT is where the
 *                  conversion belongs — not in a search predicate.
 *   "345678"       does NOT match "012345678". Suffix matching is the same
 *                  country-code assumption wearing a different hat.
 *
 * The length bounds in looksLikeCustomerPhoneQuery exist for two reasons. A
 * short fragment would match most of the tenant, and because phone matching is
 * gated on customers.view_sensitive, a permissive prefix is a cheaper
 * existence oracle than a precise one. And an unbounded digit run would
 * swallow barcodes: an EAN-13 is thirteen digits, and routing a scanned
 * product to the Customer domain would report it as not found.
 *
 * Safe to bundle for the browser: pure string work, no imports.
 */

/** Khmer digits, indexed by their ASCII value. */
const KHMER_DIGITS = "០១២៣៤៥៦៧៨៩";

/**
 * The characters a merchant can legitimately type INSIDE a phone number.
 * Anything else present means this is not a phone query.
 */
const PHONE_SHAPE_RE = /^[+]?[\d\s.\-()០-៩]+$/u;

/**
 * Below this, a digit run is a fragment, not a phone number — see the note on
 * existence oracles above. It is also the shortest Cambodian local number the
 * shape rule below accepts, so nothing shorter can reach a phone match.
 */
export const MIN_PHONE_QUERY_DIGITS = 8;

/** Longest query any customer-search validator accepts. */
export const CUSTOMER_SEARCH_MAX_QUERY_LENGTH = 100;

/** Khmer digits to ASCII, leaving every other character alone. */
export function toAsciiDigitScript(value: string): string {
  let out = "";
  for (const ch of value) {
    const khmer = KHMER_DIGITS.indexOf(ch);
    out += khmer >= 0 ? String(khmer) : ch;
  }
  return out;
}

/**
 * Everything that is not a digit, removed. This is the ONLY transformation
 * applied to either side of a phone comparison.
 */
export function toPhoneDigits(value: string): string {
  return toAsciiDigitScript(value).replace(/\D/gu, "");
}

/**
 * Whether this query is a phone number rather than a name or a code.
 *
 * Deliberately narrow, and matched to the shapes a Cambodian customer's number
 * actually takes: local (0XX XXX XXX / 0XX XXX XXXX) or international
 * (+855 ...), in any mix of spaces, dots, dashes and brackets, in ASCII or
 * Khmer digits.
 *
 * "Any long-enough digit run" would be WRONG, not merely loose: a 13-digit
 * EAN barcode is a long digit run, and treating one as a phone number would
 * route a scanned product to the Customer domain and report the product as
 * not found. The length bounds are what keep the two apart.
 */
export function looksLikeCustomerPhoneQuery(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  if (!PHONE_SHAPE_RE.test(trimmed)) return false;

  const digits = toPhoneDigits(trimmed);
  if (trimmed.startsWith("+855") || digits.startsWith("855")) {
    return digits.length >= 10 && digits.length <= 12;
  }
  if (digits.startsWith("0")) {
    return digits.length >= MIN_PHONE_QUERY_DIGITS && digits.length <= 10;
  }
  return false;
}

/**
 * Does this stored phone match this query, under the documented rule?
 *
 * Both arguments are RAW stored/typed values — the normalization happens here
 * so no caller can accidentally compare one normalized side against one raw
 * side and get a silent miss.
 */
export function phoneDigitsMatch(storedPhone: string | null, query: string): boolean {
  if (!storedPhone) return false;
  const needle = toPhoneDigits(query);
  if (needle.length < MIN_PHONE_QUERY_DIGITS) return false;
  return toPhoneDigits(storedPhone).startsWith(needle);
}

/** Trimmed, with internal whitespace runs collapsed. Never lowercased — the match is case-insensitive at the query, and the display name is the merchant's. */
export function normalizeCustomerNameQuery(raw: string): string {
  return toAsciiDigitScript(raw).replace(/\s+/gu, " ").trim();
}

/**
 * Escape the three characters Postgres LIKE/ILIKE treats as special, so a
 * merchant typing "100%" searches for the literal text rather than matching
 * every row in the tenant.
 *
 * Backslash first — escaping it after the others would double-escape the
 * backslashes this function just added.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/%/gu, "\\%").replace(/_/gu, "\\_");
}
