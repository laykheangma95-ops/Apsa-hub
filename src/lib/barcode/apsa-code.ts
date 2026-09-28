/**
 * APSA-generated product barcode format — pure, deterministic helpers.
 *
 * When a merchant has no manufacturer barcode and does not want to type one,
 * APSA mints one (session scope §3). The format here is designed to be:
 *
 *   - unique within a merchant organization  (enforced server-side by a
 *     collision check against the org-scoped unique index; this module only
 *     produces candidates and validates their shape)
 *   - variant-specific                        (each variant gets its own code)
 *   - scanner-friendly                        (uppercase A–Z / 0–9, Code 128 B safe)
 *   - free of PII and of the database UUID     (the org id only seeds a short,
 *     non-reversible prefix; the variant/customer ids never appear)
 *
 * Uniqueness is NEVER trusted from the client. This file cannot reach the
 * database; the Product service generates candidates with a crypto RNG and
 * re-checks each against the live org index before persisting (see
 * generateVariantBarcode in src/server/products/service.ts).
 *
 * Shape:  APSA <orgPrefix:4> <serial:8> <check:1>    e.g. "APSAK7Q400831527"
 *   - "APSA"      fixed brand marker, so a scan is recognisably an APSA code
 *   - orgPrefix   4 chars [A–Z0–9], a stable non-reversible hash of the org id
 *   - serial      8 decimal digits of entropy, the part that actually varies
 *   - check       one Luhn (mod-10) check digit over the serial, catching the
 *                 single-digit and adjacent-transposition misreads scanners make
 */

export const APSA_BARCODE_PREFIX = "APSA";
/** Characters allowed in the org prefix — Code 128 B safe, unambiguous uppercase. */
const PREFIX_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PREFIX_LENGTH = 4;
const SERIAL_LENGTH = 8;

/** Full length of a well-formed APSA barcode. */
export const APSA_BARCODE_LENGTH =
  APSA_BARCODE_PREFIX.length + PREFIX_LENGTH + SERIAL_LENGTH + 1;

/**
 * A stable, non-reversible 4-char prefix derived from the organization id.
 *
 * Not for uniqueness — codes are unique PER ORG by the database index regardless
 * of this — but so a human glancing at two codes can tell same-shop from
 * cross-shop, and so nothing about the raw UUID leaks. A plain FNV-1a hash folds
 * the whole id into 32 bits, then base-36 into 4 characters; it is deterministic
 * and one-way (the 4 chars cannot reconstruct the id).
 */
export function orgBarcodePrefix(organizationId: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < organizationId.length; i += 1) {
    hash ^= organizationId.charCodeAt(i);
    // FNV prime multiply, kept in 32-bit unsigned range via Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let value = hash >>> 0;
  let prefix = "";
  for (let i = 0; i < PREFIX_LENGTH; i += 1) {
    prefix = PREFIX_ALPHABET[value % PREFIX_ALPHABET.length] + prefix;
    value = Math.floor(value / PREFIX_ALPHABET.length);
  }
  return prefix;
}

/**
 * The Luhn (mod-10) check digit for a string of decimal digits.
 *
 * Standard algorithm, doubling every second digit from the right. Returns a
 * single digit 0–9. Throws on any non-digit input so a malformed serial can
 * never silently produce a "valid-looking" code.
 */
export function luhnCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) {
    throw new Error("luhnCheckDigit: input must be decimal digits only");
  }
  let sum = 0;
  let double = true; // rightmost digit is position 1; the digit LEFT of the (future) check doubles
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Build a full APSA barcode from an org id and an already-generated numeric
 * serial. Pure — the caller supplies the entropy (a crypto RNG on the server),
 * so this stays deterministic and testable. The serial is left-padded /
 * validated to exactly SERIAL_LENGTH digits.
 */
export function formatApsaBarcode(organizationId: string, serial: string): string {
  if (!/^\d+$/.test(serial)) {
    throw new Error("formatApsaBarcode: serial must be decimal digits only");
  }
  if (serial.length > SERIAL_LENGTH) {
    throw new Error(`formatApsaBarcode: serial must be at most ${SERIAL_LENGTH} digits`);
  }
  const padded = serial.padStart(SERIAL_LENGTH, "0");
  const prefix = orgBarcodePrefix(organizationId);
  const check = luhnCheckDigit(padded);
  return `${APSA_BARCODE_PREFIX}${prefix}${padded}${check}`;
}

/**
 * Whether a string is a structurally valid APSA barcode: correct prefix, correct
 * length, allowed characters, and a serial whose Luhn check digit matches. This
 * validates SHAPE only — it says nothing about whether the code exists in any
 * org (that is a database question).
 */
export function isValidApsaBarcode(code: string): boolean {
  if (typeof code !== "string" || code.length !== APSA_BARCODE_LENGTH) return false;
  if (!code.startsWith(APSA_BARCODE_PREFIX)) return false;

  const body = code.slice(APSA_BARCODE_PREFIX.length);
  const prefix = body.slice(0, PREFIX_LENGTH);
  const serial = body.slice(PREFIX_LENGTH, PREFIX_LENGTH + SERIAL_LENGTH);
  const check = body.slice(PREFIX_LENGTH + SERIAL_LENGTH);

  for (const ch of prefix) {
    if (!PREFIX_ALPHABET.includes(ch)) return false;
  }
  if (!/^\d{8}$/.test(serial)) return false;
  if (!/^\d$/.test(check)) return false;
  return luhnCheckDigit(serial) === Number(check);
}

/** Whether a code carries the APSA brand marker (cheap check, ignores validity). */
export function looksLikeApsaBarcode(code: string): boolean {
  return typeof code === "string" && code.startsWith(APSA_BARCODE_PREFIX);
}

/** The number of decimal digits of entropy an APSA serial carries. */
export const APSA_SERIAL_LENGTH = SERIAL_LENGTH;
