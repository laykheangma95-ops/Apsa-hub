# Cambodian commerce intent detection

Deterministic detection of what a Cambodian social-commerce customer is asking
for, from a raw chat message. No AI provider, no network, no state.

The engine **suggests**; a merchant decides. It never creates an order, never
touches money, and never rewrites the customer's message.

## Pipeline

```
raw message
  → normalize.ts   Khmer digits → Arabic, emoji stripped, repeats collapsed,
                   fused scripts separated ("sizeMមានអត់" → "size m មានអត់")
  → scan.ts        longest-match lexicon scan over the whole string (Khmer has
                   no word spacing), then numbers are classified: quantity,
                   size, price, house number, phone, or ignored
  → items.ts       tokens → line items, split on separators and on attribute
                   conflicts so two variants never collapse into quantity 2
  → detect.ts      signal weights → confidence band, primary intent, and the
                   suggested action identifiers
```

`context.ts` adds a bounded multi-message window for the burst-of-fragments
style ("អានេះមានអត់" / "M" / "black" / "យក2"). `catalog.ts` matches extracted
variants against the merchant's real catalog and refuses to guess when several
products qualify.

## Extending it

Almost every change belongs in `lexicon.ts` — one line per new romanization,
colour, unit, or politeness particle. The engine composes meaning from token
groups rather than matching whole sentences, so a new spelling variant does not
need new code.

Two things to know before adding a short Khmer literal:

- Khmer has no word spacing, so a two-character literal can match inside a
  longer word. Set `strictKhmerBoundary` (as "ស" = white does) and the entry is
  only accepted when what follows is not a Khmer letter, or is itself the start
  of another entry.
- Longest match wins at each position. Register the longer phrase when it means
  something different from its parts — "អត់យក" (negation) must beat "យក"
  (purchase), and "នៅសល់ប៉ុន្មាន" (how many left) must beat "ប៉ុន្មាន" (price).

## Safety rules encoded here

- The interrogative tail "អត់" is never a negation — "មានអត់?" is a stock
  question.
- Negation, change of mind, and hesitation cap the confidence and remove
  `prepare_order`; a correction updates the suggestion instead of stacking a
  contradictory one.
- Interest ("អានេះស្អាត") never reaches the prepare-order floor.
- A deictic reference ("អានេះ", "same as last time") sets
  `requiresProductResolution` — the caller must resolve it before pre-filling.
- Phone-shaped digits are flagged, never extracted into an order item, and
  address abbreviations ("TK", "PP") are never expanded.
- Suggested actions are identifiers, rendered through `conversation.intent.actions.*`
  i18next keys. No user-facing strings live in this module.

## Tests

`src/tests/khmer-intent.test.ts`, driven by the corpus in
`src/tests/fixtures/khmer-commerce-corpus.ts` (225 cases: natural Khmer,
Khmer-English mixed, romanized Khmer, negative/ambiguous, multi-item, Khmer and
Arabic digits, missing spaces, typos and casing).

```
bun test src/tests/khmer-intent.test.ts
```
