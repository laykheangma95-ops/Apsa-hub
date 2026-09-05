/**
 * Cambodia-first message intent tests.
 *
 * Covers the language brief end to end:
 *  1.  Corpus: intent, quantity, size, colour, band, and [Prepare order] (§20)
 *  2.  Corpus size floors — the corpus must stay substantial (§20)
 *  3.  The customer's original message is never rewritten
 *  4.  Politeness particles never change the detected intent
 *  5.  §18 false-positive safety — interest and negation never prepare an order
 *  6.  §12 negation and change of mind suppress, and do not stack, actions
 *  7.  §16 multi-item messages are never flattened into one variant
 *  8.  §3 numbers that are not quantities (money, size, street, phone)
 *  9.  §15 normalization: Khmer digits, emoji, repeats, missing spaces
 * 10.  §17 bounded multi-message context
 * 11.  §11 confirmation resolves against the merchant's own last message
 * 12.  §19 confidence model is monotonic in the number of compatible signals
 * 13.  §4/§5 catalog resolution never guesses
 * 14.  Suggested actions are identifiers only — no user-facing strings
 * 15.  §10 contact details are flagged, never extracted into order items
 *
 * Run: bun test src/tests/khmer-intent.test.ts
 */

import { describe, it, expect } from "bun:test";
import {
  detectIntent,
  detectConversationIntent,
  normalizeMessage,
  resolveAgainstCatalog,
  CONFIDENCE,
  type SuggestedActionId,
} from "../lib/intent";
import type { Product } from "../types";
import en from "../locales/en.json";
import km from "../locales/km.json";
import {
  FULL_CORPUS,
  KHMER_ENGLISH_MIXED,
  MULTI_ITEM,
  NATURAL_KHMER,
  NEGATIVE_AND_AMBIGUOUS,
  NUMBERS_IN_CONTEXT,
  ROMANIZED_KHMER,
  TYPOS_AND_SPACING,
} from "./fixtures/khmer-commerce-corpus";

const ACTION_IDS: SuggestedActionId[] = [
  "prepare_order",
  "check_stock",
  "send_price",
  "view_product",
  "ask_quantity",
  "ask_variant",
  "ask_address",
  "delivery_info",
  "save_contact",
  "send_photo",
  "confirm_change",
];

// ── 1. Corpus ────────────────────────────────────────────────────────────────

describe("Cambodia corpus", () => {
  for (const testCase of FULL_CORPUS) {
    it(`${testCase.input.replace(/\n/g, " ⏎ ")} → ${testCase.intent}`, () => {
      const result = detectIntent(testCase.input);

      expect(result.intent).toBe(testCase.intent);
      expect(result.band).toBe(testCase.band);
      expect(result.prepareOrder).toBe(testCase.prepareOrder);
      expect(result.quantity).toBe(testCase.quantity);
      expect(result.size).toBe(testCase.size);
      expect(result.color).toBe(testCase.color);

      if (testCase.items) expect(result.items).toEqual(testCase.items);
    });
  }
});

// ── 2. Corpus size floors ────────────────────────────────────────────────────

describe("corpus coverage (§20)", () => {
  it("holds at least 40 natural Khmer examples", () => {
    expect(NATURAL_KHMER.length).toBeGreaterThanOrEqual(40);
  });

  it("holds at least 40 Khmer-English mixed examples", () => {
    expect(KHMER_ENGLISH_MIXED.length).toBeGreaterThanOrEqual(40);
  });

  it("holds at least 20 romanized Khmer examples", () => {
    expect(ROMANIZED_KHMER.length).toBeGreaterThanOrEqual(20);
  });

  it("holds at least 20 negative / ambiguous examples", () => {
    expect(NEGATIVE_AND_AMBIGUOUS.length).toBeGreaterThanOrEqual(20);
  });

  it("covers multi-item, typo, and number-context cases", () => {
    expect(MULTI_ITEM.length).toBeGreaterThanOrEqual(5);
    expect(TYPOS_AND_SPACING.length).toBeGreaterThanOrEqual(10);
    expect(NUMBERS_IN_CONTEXT.length).toBeGreaterThanOrEqual(10);
  });

  it("contains both Khmer and Arabic digit forms", () => {
    const inputs = FULL_CORPUS.map((testCase) => testCase.input);
    expect(inputs.some((input) => /[០-៩]/.test(input))).toBe(true);
    expect(inputs.some((input) => /\d/.test(input))).toBe(true);
  });
});

// ── 3. The original message is never rewritten ───────────────────────────────

describe("original message", () => {
  it("is carried through untouched for every corpus case", () => {
    for (const testCase of FULL_CORPUS) {
      expect(detectIntent(testCase.input).original).toBe(testCase.input);
    }
  });
});

// ── 4. Politeness particles ──────────────────────────────────────────────────

describe("conversation particles", () => {
  const pairs: Array<[string, string]> = [
    ["អានេះមានអត់?", "បង អានេះមានអត់?"],
    ["មានអត់?", "មានបង?"],
    ["យក២", "យក២បង"],
    ["យក black មួយ", "ចា យក black មួយ"],
    ["size M", "អូខេបង size M"],
    ["yk 2", "yk 2 bong"],
  ];

  for (const [plain, polite] of pairs) {
    it(`${polite} keeps the intent of ${plain}`, () => {
      expect(detectIntent(polite).intent).toBe(detectIntent(plain).intent);
    });
  }
});

// ── 5. False-positive safety ─────────────────────────────────────────────────

describe("false-positive safety (§18)", () => {
  it("never prepares an order for interest, negation, or hesitation", () => {
    for (const testCase of NEGATIVE_AND_AMBIGUOUS) {
      const result = detectIntent(testCase.input);
      expect(result.prepareOrder).toBe(false);
      expect(result.suggestedActions).not.toContain("prepare_order");
    }
  });

  it("keeps interest below the prepare-order floor", () => {
    for (const input of ["អានេះស្អាត", "ចូលចិត្តអានេះ", "អានេះ cute", "នេះស្អាត"]) {
      const result = detectIntent(input);
      expect(result.confidence * 100).toBeLessThan(CONFIDENCE.prepareOrderFloor);
      expect(result.intent).toBe("interest");
    }
  });

  it("treats a bare stock question as a stock check, not an order", () => {
    for (const input of ["មានអត់?", "មានទេ?", "stock មានអត់?", "mean ot?"]) {
      const result = detectIntent(input);
      expect(result.intent).toBe("stock_check");
      expect(result.suggestedActions).toContain("check_stock");
      expect(result.prepareOrder).toBe(false);
    }
  });
});

// ── 6. Negation and change of mind ───────────────────────────────────────────

describe("negation and change of mind (§12)", () => {
  it("suppresses the order suggestion", () => {
    for (const input of ["អត់យកទេ", "មិនយក", "cancel", "លែងយក", "ot yk"]) {
      const result = detectIntent(input);
      expect(result.negated).toBe(true);
      expect(result.prepareOrder).toBe(false);
    }
  });

  it("does not read the interrogative tail អត់ as a negation", () => {
    expect(detectIntent("មានអត់?").negated).toBe(false);
    expect(detectIntent("នៅសល់អត់?").negated).toBe(false);
    expect(detectIntent("ដឹកអត់?").negated).toBe(false);
  });

  it("updates rather than stacks contradictory actions", () => {
    const result = detectIntent("អត់យក២ទេ យក១");
    expect(result.intent).toBe("change_request");
    expect(result.suggestedActions).toEqual(["confirm_change"]);
  });

  it("scopes a negation over the purchase verb that follows it", () => {
    const result = detectIntent("មិនចង់បានទេ");
    expect(result.intent).toBe("negation");
    expect(result.suggestedActions).toEqual([]);
  });
});

// ── 7. Multi-item ────────────────────────────────────────────────────────────

describe("multi-item messages (§16)", () => {
  it("keeps two variants apart instead of summing them", () => {
    const result = detectIntent("black M 1, white L 1");
    expect(result.items).toEqual([
      { color: "black", size: "M", quantity: 1 },
      { color: "white", size: "L", quantity: 1 },
    ]);
  });

  it("splits Khmer line items written without spaces", () => {
    const result = detectIntent("អានេះខ្មៅ២ ស១");
    expect(result.items).toEqual([
      { color: "black", quantity: 2 },
      { color: "white", quantity: 1 },
    ]);
  });

  it("splits on a newline", () => {
    const result = detectIntent("យកខ្មៅ M មួយ\nស L មួយ");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.color).toBe("black");
    expect(result.items[1]?.color).toBe("white");
  });

  it("splits on និង", () => {
    expect(detectIntent("យក M និង L").items).toEqual([{ size: "M" }, { size: "L" }]);
  });
});

// ── 8. Numbers that are not quantities ───────────────────────────────────────

describe("number classification (§3)", () => {
  it("does not read money as a quantity", () => {
    expect(detectIntent("$2").items).toEqual([]);
    expect(detectIntent("តម្លៃ $20").items).toEqual([]);
  });

  it("does not read a street number as a quantity", () => {
    expect(detectIntent("ផ្លូវ 271").items).toEqual([]);
    expect(detectIntent("street 271 សង្កាត់").items).toEqual([]);
  });

  it("does not read a phone number as a quantity", () => {
    for (const input of ["012 345 678", "+855 12 345 678", "0977888999"]) {
      expect(detectIntent(input).items).toEqual([]);
      expect(detectIntent(input).containsContactDetails).toBe(true);
    }
  });

  it("reads a variant number as a size", () => {
    expect(detectIntent("size 38").size).toBe("38");
    expect(detectIntent("លេខ 38").size).toBe("38");
    expect(detectIntent("38 មានអត់").size).toBe("38");
  });

  it("reads counted forms as quantities", () => {
    expect(detectIntent("យក២").quantity).toBe(2);
    expect(detectIntent("យក 2").quantity).toBe(2);
    expect(detectIntent("x2").quantity).toBe(2);
    expect(detectIntent("qty 2").quantity).toBe(2);
    expect(detectIntent("ចំនួន២").quantity).toBe(2);
    expect(detectIntent("២ដុំ").quantity).toBe(2);
  });

  it("does not read a delivery duration as a quantity", () => {
    expect(detectIntent("ប៉ុន្មានថ្ងៃដល់?").items).toEqual([]);
    expect(detectIntent("2 ថ្ងៃដល់អត់?").items).toEqual([]);
  });
});

// ── 9. Normalization ─────────────────────────────────────────────────────────

describe("chat normalization (§15)", () => {
  it("converts Khmer digits to Arabic digits", () => {
    expect(normalizeMessage("យក២")).toBe("យក 2");
    expect(normalizeMessage("១២៣")).toBe("123");
  });

  it("preserves Khmer vowel signs and coeng", () => {
    expect(normalizeMessage("មានអត់?")).toBe("មានអត់");
    expect(normalizeMessage("ខ្មៅ")).toBe("ខ្មៅ");
  });

  it("separates fused scripts, sizes, and multipliers", () => {
    expect(normalizeMessage("sizeMមានអត់")).toBe("size m មានអត់");
    expect(normalizeMessage("Mx2")).toBe("m x 2");
    expect(normalizeMessage("black2")).toBe("black 2");
  });

  it("removes emoji and collapses repeats", () => {
    expect(normalizeMessage("យកហើយ😍")).toBe("យកហើយ");
    expect(normalizeMessage("មានអត់???")).toBe("មានអត់");
    expect(normalizeMessage("ស្អាតតត")).toBe("ស្អាត");
  });

  it("keeps XXL intact while collapsing other repeats", () => {
    expect(normalizeMessage("XXL")).toBe("xxl");
    expect(detectIntent("XXL មានអត់").size).toBe("XXL");
  });

  it("does not change the customer's message itself", () => {
    const input = "យកកក black 2 😍";
    expect(detectIntent(input).original).toBe(input);
  });
});

// ── 10. Bounded conversation context ─────────────────────────────────────────

describe("multi-message context (§17)", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 5, 10, 0, seconds)).toISOString();

  it("combines a burst of short fragments into one suggestion", () => {
    const result = detectConversationIntent([
      { body: "អានេះមានអត់", direction: "inbound", at: at(0) },
      { body: "M", direction: "inbound", at: at(20) },
      { body: "black", direction: "inbound", at: at(30) },
      { body: "យក2", direction: "inbound", at: at(40) },
    ]);

    expect(result.intent).toBe("purchase");
    expect(result.items).toEqual([{ size: "M", color: "black", quantity: 2 }]);
    expect(result.prepareOrder).toBe(true);
    expect(result.contextWindow).toHaveLength(4);
    expect(result.original).toBe("យក2");
  });

  it("bounds the window by age", () => {
    const result = detectConversationIntent([
      {
        body: "black",
        direction: "inbound",
        at: new Date(Date.UTC(2026, 8, 5, 6, 0, 0)).toISOString(),
      },
      { body: "យក2", direction: "inbound", at: at(40) },
    ]);

    expect(result.contextWindow).toEqual(["យក2"]);
    expect(result.color).toBeUndefined();
  });

  it("bounds the window by message count", () => {
    const messages = ["black", "M", "cream", "L", "XL", "យក2"].map((body, index) => ({
      body,
      direction: "inbound" as const,
      at: at(index),
    }));

    const result = detectConversationIntent(messages, { maxMessages: 3 });
    expect(result.contextWindow).toHaveLength(3);
  });

  it("drops stale context after a cancellation", () => {
    const result = detectConversationIntent([
      { body: "យក black M", direction: "inbound", at: at(0) },
      { body: "អត់យកទេ", direction: "inbound", at: at(10) },
    ]);

    expect(result.intent).toBe("negation");
    expect(result.prepareOrder).toBe(false);
    expect(result.contextWindow).toEqual(["អត់យកទេ"]);
  });

  it("does not merge a self-contained message with older fragments", () => {
    const result = detectConversationIntent([
      { body: "black", direction: "inbound", at: at(0) },
      {
        body: "ចង់ដឹងតម្លៃ delivery ទៅ ខេត្ត ប៉ុន្មាន ដែរបងសម្រាប់ អាហ្នឹង",
        direction: "inbound",
        at: at(10),
      },
    ]);

    expect(result.contextWindow).toHaveLength(1);
  });
});

// ── 11. Confirmation against the merchant's message ──────────────────────────

describe("confirmation (§11)", () => {
  it("does not invent an order from a standalone confirmation", () => {
    const result = detectIntent("បានបង");
    expect(result.intent).toBe("confirmation");
    expect(result.items).toEqual([]);
    expect(result.prepareOrder).toBe(false);
  });

  it("strengthens the merchant's own summary when the customer agrees", () => {
    const result = detectConversationIntent([
      { body: "M black 2 មែនទេ?", direction: "outbound" },
      { body: "បានបង", direction: "inbound" },
    ]);

    expect(result.derivedFromMerchantMessage).toBe(true);
    expect(result.items).toEqual([{ size: "M", color: "black", quantity: 2 }]);
    expect(result.prepareOrder).toBe(true);
    expect(result.requiresProductResolution).toBe(true);
  });

  it("stays inert when there is nothing to confirm", () => {
    const result = detectConversationIntent([{ body: "បានបង", direction: "inbound" }]);
    expect(result.derivedFromMerchantMessage).toBe(false);
    expect(result.prepareOrder).toBe(false);
  });
});

// ── 12. Confidence model ─────────────────────────────────────────────────────

describe("confidence model (§19)", () => {
  it("rises as compatible signals accumulate", () => {
    const strongest = detectIntent("យក black M 2").confidence;
    const strong = detectIntent("យកអានេះ").confidence;
    const weak = detectIntent("black M").confidence;
    const interest = detectIntent("អានេះស្អាត").confidence;

    expect(strongest).toBeGreaterThan(strong);
    expect(strong).toBeGreaterThan(weak);
    expect(weak).toBeGreaterThan(interest);
  });

  it("bands the strongest signal set as high", () => {
    expect(detectIntent("យក black M 2").band).toBe("high");
    expect(detectIntent("យក black M 2").prepareOrder).toBe(true);
  });

  it("asks for what a strong purchase is missing", () => {
    const result = detectIntent("យកអានេះ");
    expect(result.suggestedActions[0]).toBe("prepare_order");
    expect(result.suggestedActions).toContain("ask_quantity");
    expect(result.requiresProductResolution).toBe(true);
  });

  it("keeps a bare variant mention at check-stock strength", () => {
    const result = detectIntent("black M");
    expect(result.band).toBe("low");
    expect(result.suggestedActions).toEqual(["check_stock"]);
  });

  it("is capped once the message is negated", () => {
    expect(detectIntent("អត់យក២ទេ យក១").confidence * 100).toBeLessThanOrEqual(
      CONFIDENCE.negatedCeiling,
    );
  });
});

// ── 13. Catalog resolution ───────────────────────────────────────────────────

describe("catalog resolution (§4/§5)", () => {
  const products: Product[] = [
    {
      id: "prod-tee",
      nameKm: "អាវយឺត",
      nameEn: "Cotton tee",
      sku: "TEE-1",
      price: { amount: 990, currency: "USD" },
      stock: null,
      lowStockThreshold: 3,
      companion: "nilo",
      options: [
        { name: "Color", values: ["Black", "Cream"] },
        { name: "Size", values: ["M", "L"] },
      ],
    },
    {
      id: "prod-bag",
      nameKm: "កាបូប",
      nameEn: "Shoulder bag",
      sku: "BAG-1",
      price: { amount: 2490, currency: "USD" },
      stock: null,
      lowStockThreshold: 1,
      companion: "vela",
      options: [{ name: "ពណ៌", values: ["ខ្មៅ"] }],
    },
  ];

  it("resolves a single unambiguous match", () => {
    const [resolved] = resolveAgainstCatalog(detectIntent("យក black M 2").items, products);
    expect(resolved?.productId).toBe("prod-tee");
  });

  it("matches Khmer catalog values against English customer wording", () => {
    const [resolved] = resolveAgainstCatalog(detectIntent("យកខ្មៅ").items, products);
    expect(resolved?.candidateProductIds).toEqual(["prod-tee", "prod-bag"]);
  });

  it("refuses to guess when several products match", () => {
    const [resolved] = resolveAgainstCatalog(detectIntent("យក black 2").items, products);
    expect(resolved?.productId).toBeUndefined();
    expect(resolved?.candidateProductIds).toHaveLength(2);
  });

  it("reports attributes the catalog does not carry", () => {
    const [resolved] = resolveAgainstCatalog(detectIntent("យក navy 2").items, products);
    expect(resolved?.candidateProductIds).toEqual([]);
    expect(resolved?.unmatchedAttributes).toEqual(["navy"]);
  });
});

// ── 14. Actions are identifiers, not strings ─────────────────────────────────

describe("suggested actions", () => {
  it("only ever emits known identifiers", () => {
    for (const testCase of FULL_CORPUS) {
      for (const action of detectIntent(testCase.input).suggestedActions) {
        expect(ACTION_IDS).toContain(action);
      }
    }
  });

  it("emits at most three actions", () => {
    for (const testCase of FULL_CORPUS) {
      expect(detectIntent(testCase.input).suggestedActions.length).toBeLessThanOrEqual(3);
    }
  });

  it("has a Khmer and an English label for every action", () => {
    const enActions = en.conversation.intent.actions as Record<string, string>;
    const kmActions = km.conversation.intent.actions as Record<string, string>;

    for (const action of ACTION_IDS) {
      expect(enActions[action]).toBeTruthy();
      expect(kmActions[action]).toBeTruthy();
    }
  });

  it("does not uppercase any Khmer label", () => {
    const kmActions = km.conversation.intent.actions as Record<string, string>;
    for (const label of Object.values(kmActions)) {
      expect(label).toBe(label.toLocaleLowerCase("km"));
    }
  });
});

// ── 15. Contact details ──────────────────────────────────────────────────────

describe("contact details (§10)", () => {
  it("flags a phone number without copying it into an order item", () => {
    const result = detectIntent("នេះលេខខ្ញុំ 012 345 678");
    expect(result.containsContactDetails).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.suggestedActions).toContain("save_contact");
  });

  it("does not resolve an address abbreviation", () => {
    const result = detectIntent("ខ្ញុំនៅ TK");
    expect(result.intent).toBe("address");
    expect(result.items).toEqual([]);
  });
});
