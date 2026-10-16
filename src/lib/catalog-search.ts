/**
 * The Products catalogue's search and paging contract, written once.
 *
 * Two sides need the SAME answer to "what was searched?": the browser, which
 * files a page under a cache key built from the search, and the server, which
 * decides which rows match it (src/server/products/service.ts). If they
 * normalized differently, "tea " and "tea" would be two cache entries for one
 * server answer, or a page would be refused as the answer to a different
 * question. So the rule lives here as pure string work and both import it.
 *
 * ── WHAT SEARCH MATCHES ──────────────────────────────────────────────────────
 *
 * A product matches when the normalized query is a case-insensitive SUBSTRING
 * of any of:
 *
 *   - its Khmer name (products.name_km)
 *   - its English name (products.name_en)
 *   - an ACTIVE variant's name, SKU or barcode (product_variants)
 *
 * across the caller's WHOLE organization, under the chosen status and
 * category — not just the rows already loaded. Archived variants are not
 * searched, matching what the list shows for each product.
 *
 * Normalization, applied identically on both sides:
 *
 *   - Unicode NFC, so a Khmer vowel or sign typed as a decomposed sequence
 *     compares as the precomposed one where Unicode defines one.
 *   - ZERO WIDTH SPACE (U+200B) and the byte-order mark (U+FEFF) removed. Khmer
 *     keyboards and copy-paste insert U+200B as an invisible word break; a
 *     query carrying one would otherwise miss a name that does not. ZWNJ/ZWJ
 *     are left alone: they change how Khmer renders.
 *   - Whitespace runs collapsed to one space, then trimmed.
 *   - At most CATALOG_SEARCH_MAX_LENGTH characters.
 *
 * SKU and barcode are additionally compared with Khmer digits (០-៩) read as
 * ASCII digits, so "៨៨៥០" typed on a Khmer keyboard finds barcode 8850.
 * Barcodes are Code 128 ASCII by construction (assertBarcodeEncodable), so a
 * Khmer digit can never be part of one.
 *
 * Known limits, stated rather than hidden:
 *
 *   - A stored name that itself contains U+200B INSIDE the searched text is
 *     not normalized on the database side, so "កាហ្វេទឹកដោះគោ" does not find
 *     "កាហ្វេ\u200Bទឹកដោះគោ". Fixing that needs a normalized search column (a
 *     migration), proposed separately rather than added here.
 *   - "*" cannot be escaped through PostgREST (it expands "*" to "%" in a
 *     like/ilike value), so a typed asterisk still behaves as a wildcard. That
 *     over-matches; it can never hide a product that exists. Same rule as the
 *     customer search (src/server/customers/repository.ts).
 *
 * Safe to bundle for the browser: no server imports.
 */
import { toAsciiDigitScript } from "@/lib/customer-search";

/** The longest search the server accepts, after normalization. */
export const CATALOG_SEARCH_MAX_LENGTH = 100;

/** The search box's own limit on raw input (the server accepts up to 400). */
export const CATALOG_SEARCH_INPUT_MAX = 200;

/** How long typing must pause before the Products screen asks the server. */
export const CATALOG_SEARCH_DEBOUNCE_MS = 300;

const INVISIBLE_BREAKS = /[\u200B\uFEFF]/gu;

/** The query as both sides compare it. "" means "no search". */
export function normalizeCatalogSearch(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(INVISIBLE_BREAKS, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, CATALOG_SEARCH_MAX_LENGTH)
    .trim();
}

/** The form SKU and barcode are compared in: Khmer digits read as ASCII. */
export function catalogIdentifierSearch(normalized: string): string {
  return toAsciiDigitScript(normalized);
}

/**
 * A timestamptz exactly as PostgREST renders it
 * ("2026-10-15T09:30:00.123456+00:00"). The same shape the Orders cursor
 * accepts (src/api/orders.ts). Strict on purpose: a cursor is echoed back from
 * a previous page, never typed by a person, so anything else is a malformed or
 * tampered request.
 */
export const CATALOG_CURSOR_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/;

/**
 * A position in the catalogue list: the (created_at, id) of the last product a
 * page returned. `createdAt` is the database's own timestamptz text, passed
 * back untouched — a JavaScript Date would drop the microseconds, and two
 * products a few microseconds apart would then compare as one.
 *
 * A position, not a credential. The repository filters on the caller's
 * server-resolved organization before it applies one, so a forged or foreign
 * cursor can only move within the caller's own catalogue.
 */
export interface CatalogListCursor {
  createdAt: string;
  id: string;
}
