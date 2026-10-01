/**
 * Barcode normalization — clean a raw decoded value for identity classification
 * and database lookup.
 *
 * Every scan path (camera, wedge, manual entry) passes through this before the
 * scan identity router classifies the value. The goal is to produce the
 * canonical form that the database stores, so an exact-match lookup works even
 * when a scanner appends a suffix, a camera decodes trailing whitespace, or a
 * UPC-A code needs the EAN-13 leading zero.
 *
 * Rules:
 *   - ASCII control characters (0x00–0x1F, 0x7F) are stripped: GS1 FNC1 (0x1D),
 *     carriage return, line feed, and null bytes are scanner artifacts, never
 *     part of a stored barcode.
 *   - Leading and trailing whitespace is trimmed.
 *   - Empty or excessively long results are rejected (null).
 *   - UPC-A ↔ EAN-13 normalization: a 12-digit all-numeric value is expanded to
 *     13 digits with a leading "0" (standard EAN-13 form), so a single database
 *     value matches both scanner modes.
 *   - APSA-specific codes (parcels, QR payloads) are left untouched — they are
 *     case-sensitive and fixed-format.
 *
 * Pure, deterministic, no I/O. Safe to import from client or server.
 */

const MAX_BARCODE_LENGTH = 100;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

const ALL_DIGITS_RE = /^\d+$/;

/**
 * Normalize a raw scanned value into a form suitable for classification and
 * lookup. Returns null when the input is unusable (empty, too long, not a
 * string).
 */
export function normalizeScanInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const cleaned = raw.replace(CONTROL_CHARS_RE, "").trim();
  if (cleaned.length === 0 || cleaned.length > MAX_BARCODE_LENGTH) return null;

  return cleaned;
}

/**
 * Expand a 12-digit UPC-A to its 13-digit EAN-13 equivalent by prepending "0".
 * Returns the original value unchanged if it is not a 12-digit all-numeric
 * string — never guesses, never truncates.
 *
 * This is a standard retail barcode normalization: UPC-A is a subset of EAN-13
 * with an implicit leading zero, and many databases store only the 13-digit
 * form. The router tries BOTH the normalized and original value when looking up
 * product barcodes, so a scanner that returns the 12-digit form still matches.
 */
export function upcAToEan13(code: string): string | null {
  if (code.length === 12 && ALL_DIGITS_RE.test(code)) {
    return "0" + code;
  }
  return null;
}

/**
 * For a 13-digit EAN-13 with a leading "0", return the 12-digit UPC-A form.
 * Returns null if the input is not a 13-digit string starting with "0".
 */
export function ean13ToUpcA(code: string): string | null {
  if (code.length === 13 && code[0] === "0" && ALL_DIGITS_RE.test(code)) {
    return code.slice(1);
  }
  return null;
}
