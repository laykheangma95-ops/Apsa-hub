/**
 * The merchant-facing order code, and the exact normalization applied to it.
 *
 * `orders.order_number` is the human reference a merchant and a customer say
 * out loud — "APSA-2026-000123". Migration 023 states plainly that it is
 * NEVER a security identifier, and nothing here changes that: the lookup
 * behind this module is scoped to the organization the server resolved from
 * the caller's membership, exactly like every id lookup, so a code from
 * another tenant matches no row and is indistinguishable from one that was
 * never issued.
 *
 * ── WHAT NORMALIZATION IS SAFE HERE, AND WHY ─────────────────────────────────
 *
 * Only transformations that CANNOT change which stored code a query matches
 * are applied, which is what makes them safe rather than merely convenient.
 * allocate_order_number (migration 024) is the only writer, and it emits
 * exactly:
 *
 *     'APSA-' || year || '-' || lpad(number, 6, '0')
 *
 * — uppercase ASCII letters, ASCII digits and hyphens, and no whitespace at
 * all. So:
 *
 *   - UPPERCASING the query is safe: every stored code is already uppercase,
 *     so "apsa-2026-000123" and "APSA-2026-000123" can only ever name the same
 *     row. The query is uppercased, never the column, so the lookup still uses
 *     uniq_orders_number_per_org.
 *   - REMOVING ALL WHITESPACE is safe: no stored code contains any, so a space
 *     can only ever be paste damage ("APSA-2026-000123 " off the end of a chat
 *     message). Dropping it cannot make a query match a DIFFERENT code.
 *   - Khmer digits map to ASCII, because a Khmer keyboard types ០១២ and no
 *     stored code contains a Khmer digit.
 *
 * Nothing else is attempted. In particular the year segment is never inferred,
 * padded or supplied: "APSA-123" is looked up verbatim as "APSA-123" and
 * honestly finds nothing, rather than being rewritten into a guess at which
 * year's order the merchant meant.
 *
 * FUZZY MATCHING IS NOT SUPPORTED, deliberately. An order code identifies one
 * order and money is attached to it; "did you mean" on a financial record is
 * how a merchant refunds the wrong sale.
 *
 * Safe to bundle for the browser: pure string work, no imports.
 */
import { toAsciiDigitScript } from "@/lib/customer-search";

/** Long enough for any allocated code plus paste damage; short enough to bound the validator. */
export const ORDER_CODE_MAX_LENGTH = 64;

/**
 * Order-code shape: the APSA prefix followed by digits and hyphens.
 *
 * Matches the allocated format (APSA-2026-000123) and the shorter forms a
 * merchant may still have written down, without matching a SKU, a tracking
 * number or a courier reference that merely contains digits.
 */
const ORDER_CODE_RE = /^APSA-\d+(?:-\d+)*$/u;

/**
 * Trim, drop all whitespace, map Khmer digits, uppercase. See the module note
 * for why each of these cannot change which row a query names.
 */
export function normalizeOrderCode(raw: string): string {
  return toAsciiDigitScript(raw).replace(/\s+/gu, "").toUpperCase();
}

/** Whether this input reads as an order code, once normalized. */
export function looksLikeOrderCode(normalized: string): boolean {
  if (normalized.length === 0 || normalized.length > ORDER_CODE_MAX_LENGTH) return false;
  return ORDER_CODE_RE.test(normalized);
}
