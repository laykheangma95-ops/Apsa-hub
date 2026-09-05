/**
 * Lexicon scanner: normalized message → ordered tokens.
 *
 * Matching is longest-match, left-to-right, over the whole normalized string
 * (Khmer has no word spacing, so token-splitting alone cannot work). Numbers are
 * emitted as raw `number` tokens and classified afterwards, because the same
 * digit can be a quantity, a size, a price, a house number, or a phone number.
 */
import { LEXICON, type LexiconEntry } from "./lexicon";
import { isDigitChar, isLatinAlnumChar, isKhmerChar } from "./normalize";
import type { IntentToken, SignalKind } from "./types";

const INDEX = new Map<string, LexiconEntry>();
let MAX_LEN = 1;

for (const entry of LEXICON) {
  const existing = INDEX.get(entry.match);
  if (existing) {
    // Same literal declared twice — keep one token carrying both meanings.
    const kinds = [...new Set([...existing.kinds, ...entry.kinds])];
    INDEX.set(entry.match, {
      ...existing,
      kinds,
      ...((existing.value ?? entry.value) !== undefined
        ? { value: existing.value ?? entry.value }
        : {}),
    });
  } else {
    INDEX.set(entry.match, entry);
  }
  MAX_LEN = Math.max(MAX_LEN, entry.match.length);
}

/** Exposed for tests: the compiled entry for a literal, if any. */
export function lexiconEntry(match: string): LexiconEntry | undefined {
  return INDEX.get(match);
}

function entryAt(text: string, index: number, allowStrict: boolean): LexiconEntry | undefined {
  const limit = Math.min(MAX_LEN, text.length - index);
  for (let length = limit; length > 0; length -= 1) {
    const slice = text.slice(index, index + length);
    const entry = INDEX.get(slice);
    if (!entry) continue;

    const end = index + length;
    if (isLatinAlnumChar(slice[0]) && isLatinAlnumChar(text[index - 1])) continue;
    if (isLatinAlnumChar(slice[slice.length - 1]) && isLatinAlnumChar(text[end])) continue;

    if (entry.strictKhmerBoundary && isKhmerChar(text[end])) {
      // Only accept a short Khmer literal when the text that follows starts a
      // known word — otherwise we are inside a longer Khmer word.
      if (!allowStrict || !entryAt(text, end, false)) continue;
    }

    return entry;
  }
  return undefined;
}

/**
 * Digit runs that belong to a phone number. Cambodian numbers appear with or
 * without spaces, with hyphens (already normalized away), and with a +855
 * prefix. Values are located, never extracted — see SECURITY.md on sensitive
 * customer data.
 */
export function findPhoneSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const pattern = /(?:\+?855[\d ]*|0[\d ]*|\d{8,})/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const raw = match[0];
    const trimmed = raw.replace(/\s+$/, "");
    const digits = trimmed.replace(/\D/g, "").length;
    if (digits >= 8) spans.push([match.index, match.index + trimmed.length]);
    match = pattern.exec(text);
  }
  return spans;
}

function inSpan(spans: Array<[number, number]>, start: number, end: number): boolean {
  return spans.some(([from, to]) => start < to && end > from);
}

const SKIPPABLE: SignalKind[] = ["particle", "question", "separator"];

function isSkippable(token: IntentToken): boolean {
  return token.kinds.every((kind) => SKIPPABLE.includes(kind));
}

/** Nearest token before/after `index` that carries meaning. */
function neighbour(tokens: IntentToken[], index: number, step: -1 | 1): IntentToken | undefined {
  for (let i = index + step; i >= 0 && i < tokens.length; i += step) {
    const token = tokens[i];
    if (!token) return undefined;
    if (token.kinds.includes("separator")) return undefined;
    if (!isSkippable(token)) return token;
  }
  return undefined;
}

function has(token: IntentToken | undefined, ...kinds: SignalKind[]): boolean {
  return Boolean(token && kinds.some((kind) => token.kinds.includes(kind)));
}

export interface ScanOptions {
  /**
   * True when the message is one fragment of a bounded conversation window. A
   * bare number ("2") is only read as a quantity in that mode.
   */
  fragmentContext?: boolean;
}

/** Tokenize a normalized message. */
export function scan(normalized: string, options: ScanOptions = {}): IntentToken[] {
  const phoneSpans = findPhoneSpans(normalized);
  const tokens: IntentToken[] = [];

  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === undefined || ch === " ") {
      i += 1;
      continue;
    }

    if (isDigitChar(ch)) {
      let end = i;
      while (end < normalized.length && isDigitChar(normalized[end])) end += 1;
      const text = normalized.slice(i, end);
      tokens.push({
        kinds: inSpan(phoneSpans, i, end) ? ["phone"] : ["number"],
        text,
        value: Number(text),
        start: i,
        end,
      });
      i = end;
      continue;
    }

    const entry = entryAt(normalized, i, true);
    if (entry) {
      tokens.push({
        kinds: entry.kinds,
        text: entry.match,
        ...(entry.value !== undefined ? { value: entry.value } : {}),
        ...(entry.weight !== undefined ? { weight: entry.weight } : {}),
        start: i,
        end: i + entry.match.length,
      });
      i += entry.match.length;
      continue;
    }

    i += 1;
  }

  return classifyNumbers(normalized, tokens, options);
}

const QUANTITY_ANCHORS: SignalKind[] = [
  "unit",
  "multiplier",
  "qty_marker",
  "color",
  "size",
  "product_ref",
  "purchase",
  "send_request",
  "quantity",
  "price",
  "repeat",
];

/**
 * §3: "Do not assume every number is quantity." A digit only becomes a quantity
 * when nothing else claims it and something nearby makes it a count.
 */
function classifyNumbers(
  normalized: string,
  tokens: IntentToken[],
  options: ScanOptions,
): IntentToken[] {
  const hasPurchase = tokens.some((token) => token.kinds.includes("purchase"));
  const hasStockQuestion = tokens.some(
    (token) => token.kinds.includes("stock") || token.kinds.includes("size_marker"),
  );
  const onlyToken = tokens.length === 1;

  return tokens.map((token, index) => {
    if (!token.kinds.includes("number")) return token;

    const value = Number(token.value);
    const before = neighbour(tokens, index, -1);
    const after = neighbour(tokens, index, 1);
    const charBefore = normalized[token.start - 1];
    const charAfter = normalized[token.end];

    if (charBefore === "$" || has(before, "currency") || has(after, "currency")) {
      return { ...token, kinds: ["price_amount"] };
    }
    if (charAfter === "%") return { ...token, kinds: ["discount_amount"] };
    if (has(before, "size_marker")) return { ...token, kinds: ["size"], value: String(value) };
    if (has(before, "address_marker")) return { ...token, kinds: ["address_number"] };
    if (has(before, "image_marker")) return { ...token, kinds: ["image_index"] };
    if (has(after, "time_marker") || has(before, "time_marker")) {
      return { ...token, kinds: ["ignored"] };
    }

    // §4: "38 មានអត់?" — a shoe/apparel size asked without the word "size".
    const looksLikeNumericSize =
      hasStockQuestion &&
      value >= 30 &&
      value <= 50 &&
      !has(before, "unit", "multiplier", "qty_marker") &&
      !has(after, "unit", "multiplier", "qty_marker");
    if (looksLikeNumericSize) return { ...token, kinds: ["size"], value: String(value) };

    const countable = Number.isInteger(value) && value >= 1 && value <= 99;
    const anchored =
      has(before, ...QUANTITY_ANCHORS) ||
      has(after, ...QUANTITY_ANCHORS) ||
      hasPurchase ||
      (Boolean(options.fragmentContext) && onlyToken);

    if (countable && anchored) return { ...token, kinds: ["quantity"] };
    return { ...token, kinds: ["ignored"] };
  });
}
