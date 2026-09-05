/**
 * Chat normalization for Cambodian social-commerce messages.
 *
 * Real messages arrive with Khmer digits, emoji, repeated characters, missing
 * spaces between scripts, and inconsistent casing. Normalization makes them
 * matchable. It is lossy on purpose — the caller keeps the original message and
 * only ever displays that.
 */

const KHMER_DIGITS = "០១២៣៤៥៦៧៨៩";

/** Khmer block + Khmer symbols. */
const KHMER_RANGE = /[ក-៿᧠-᧿]/;
const LATIN_ALNUM = /[a-z0-9]/;

export function isKhmerChar(ch: string | undefined): boolean {
  return ch !== undefined && KHMER_RANGE.test(ch);
}

export function isLatinAlnumChar(ch: string | undefined): boolean {
  return ch !== undefined && LATIN_ALNUM.test(ch);
}

export function isDigitChar(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/** Khmer ០-៩ → 0-9. Arabic digits pass through untouched. */
export function khmerDigitsToArabic(input: string): string {
  let out = "";
  for (const ch of input) {
    const index = KHMER_DIGITS.indexOf(ch);
    out += index === -1 ? ch : String(index);
  }
  return out;
}

/**
 * Normalize a raw message for rule matching.
 *
 * Guarantees for downstream matchers:
 * - lowercase Latin, Arabic digits only
 * - single spaces, no emoji, no stray punctuation
 * - `,` is the only surviving punctuation and marks a line-item separator
 * - `$` and `%` survive so numbers can be classified as money, not quantity
 * - script boundaries (Khmer|Latin|digit) are separated by a space
 */
export function normalizeMessage(input: string): string {
  let text = input.normalize("NFC");

  text = khmerDigitsToArabic(text);

  // Zero-width and non-breaking characters carry no meaning in chat.
  text = text.replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\u00a0/g, " ");

  // Variation selectors first, so no character class below can combine with one.
  text = text.replace(/\ufe0f|\ufe0e/g, "");

  // Emoji, pictographs, and arrows.
  text = text.replace(
    /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu,
    " ",
  );

  text = text.toLowerCase();

  // Line breaks, semicolons, and pipes behave like a comma: a new line item.
  text = text.replace(/[\n\r;|/]+/g, " , ");

  // Collapse padded repeats ("យក ក ក" stays; "!!!" and "ស្អាតតត" collapse).
  // Digits are excluded so phone numbers survive, and `x` is excluded so XXL
  // survives.
  text = text.replace(/([^\dxa-z\s,$%])\1{2,}/gu, "$1");
  text = text.replace(/([a-wyz])\1{2,}/g, "$1");

  // "sizeM" / "size38" — the marker and its value fused.
  text = text.replace(/\bsize(?=[a-z0-9])/g, "size ");
  // "Mx2" — multiplier fused between a size letter and a count.
  text = text.replace(/([a-z])x(?=\d)/g, "$1 x ");

  // Script boundaries: Khmer|Latin, Khmer|digit, Latin|digit.
  text = text.replace(/([ក-៿᧠-᧿])([a-z0-9$])/gu, "$1 $2");
  text = text.replace(/([a-z0-9$])([ក-៿᧠-᧿])/gu, "$1 $2");
  text = text.replace(/([a-z])(\d)/g, "$1 $2");
  text = text.replace(/(\d)([a-z])/g, "$1 $2");

  // Keep `+` only when it introduces a country code.
  text = text.replace(/\+(?!\d)/g, " ");

  // Everything else that is not a letter, a combining mark (Khmer vowels and
  // coeng are marks, not letters), a digit, or a marker we rely on.
  text = text.replace(/[^\p{L}\p{M}\p{N}\s,$%+]/gu, " ");

  // A comma is a separator token in its own right.
  text = text.replace(/,/g, " , ");

  return text.replace(/\s+/g, " ").trim();
}

/** True when a message is short enough to be treated as a conversation fragment. */
export function isFragment(normalized: string): boolean {
  return normalized.length <= 40;
}
