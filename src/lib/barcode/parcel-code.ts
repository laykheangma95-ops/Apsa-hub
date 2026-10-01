/**
 * APSA parcel code format — pure, client-safe helpers.
 *
 * A parcel code is the opaque, permanent identifier printed on a shipping label
 * as both QR and Code 128. It is the ONLY scannable reference to a parcel; the
 * internal UUID and the order id never appear in the code.
 *
 * Format:  APSA:PCL:v1:<22 base64url chars>
 *
 *   - "APSA:PCL:v1:" — fixed prefix identifying an APSA parcel code, version 1
 *   - 22 characters of base64url (A-Z, a-z, 0-9, -, _) encoding 128 bits of
 *     cryptographic randomness (crypto.randomBytes(16) on the server)
 *
 * Properties:
 *   - 128-bit entropy: collision probability < 2^-64 even at billions of parcels
 *   - non-sequential, non-guessable (crypto RNG, not a counter)
 *   - case-sensitive (stored and compared exactly as generated)
 *   - QR-safe, URL-safe, Code 128 B safe (all chars are printable ASCII)
 *   - immutable after creation — reprinting reuses the same code
 *   - carries NO PII, no org id, no order data
 *
 * The server generates codes; this module only validates shape. A structurally
 * valid code may not exist in any org — existence is a database question.
 */

export const PARCEL_CODE_PREFIX = "APSA:PCL:v1:";

/** Length of the random token portion (base64url of 16 bytes = 22 chars). */
export const PARCEL_CODE_TOKEN_LENGTH = 22;

/** Total length of a well-formed parcel code (12 + 22 = 34). */
export const PARCEL_CODE_LENGTH = PARCEL_CODE_PREFIX.length + PARCEL_CODE_TOKEN_LENGTH;

/** Characters allowed in the token portion: base64url alphabet. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Whether a string is a structurally valid APSA parcel code: correct prefix,
 * correct length, and a token portion using only base64url characters. This
 * validates SHAPE only — it says nothing about whether the code exists.
 */
export function isValidParcelCode(code: string): boolean {
  if (typeof code !== "string") return false;
  if (code.length !== PARCEL_CODE_LENGTH) return false;
  if (!code.startsWith(PARCEL_CODE_PREFIX)) return false;
  const token = code.slice(PARCEL_CODE_PREFIX.length);
  return BASE64URL_RE.test(token);
}

/**
 * Cheap prefix check — true when a string starts with the APSA parcel prefix.
 * Does NOT validate length or token characters; use isValidParcelCode for that.
 */
export function looksLikeParcelCode(code: string): boolean {
  return typeof code === "string" && code.startsWith(PARCEL_CODE_PREFIX);
}
