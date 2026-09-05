/**
 * Cambodia-first message intent detection — shared types.
 *
 * This layer is deterministic and provider-free: it turns a raw customer chat
 * message (Khmer, romanized Khmer, English, or any mix) into structured
 * commerce signals. It never rewrites the customer's message — the original is
 * always carried through untouched for display.
 *
 * No user-facing strings are produced here. Suggested actions are identifiers
 * that the UI renders through i18next.
 */

/** Every token class the scanner can emit. */
export type SignalKind =
  // ── commerce intent ────────────────────────────────────────────────────────
  | "purchase"
  | "send_request"
  | "repeat"
  | "interest"
  | "stock"
  | "price"
  | "discount"
  | "delivery"
  | "delivery_free"
  | "address"
  | "phone"
  | "confirm"
  | "negate"
  | "change"
  | "hesitate"
  | "photo_request"
  // ── extraction ─────────────────────────────────────────────────────────────
  | "product_ref"
  | "color"
  | "size"
  | "quantity"
  | "unit"
  | "multiplier"
  // ── markers (shape the meaning of a neighbouring number) ────────────────────
  | "qty_marker"
  | "size_marker"
  | "color_marker"
  | "address_marker"
  | "phone_marker"
  | "image_marker"
  | "currency"
  | "time_marker"
  | "number"
  | "price_amount"
  | "discount_amount"
  | "address_number"
  | "image_index"
  // ── grammar / noise ────────────────────────────────────────────────────────
  | "separator"
  | "particle"
  | "question"
  | "ignored";

/** A single lexicon or numeric match inside the normalized message. */
export interface IntentToken {
  kinds: SignalKind[];
  /** matched text, taken from the NORMALIZED message (never shown to users) */
  text: string;
  /** canonical value: colour slug, size label, or numeric quantity */
  value?: string | number;
  /** relative strength of the matched lexicon entry inside its category */
  weight?: number;
  start: number;
  end: number;
}

/**
 * One candidate line item extracted from a message. Values are raw customer
 * vocabulary, not catalog identifiers — see `resolveAgainstCatalog`.
 */
export interface LineItemCandidate {
  /** canonical colour slug, e.g. "black" (Khmer ខ្មៅ and English "black" both map here) */
  color?: string;
  /** canonical size label, e.g. "M", "XL", "38", "FREE" */
  size?: string;
  quantity?: number;
  /** canonical unit slug when the customer stated one, e.g. "pcs", "pair" */
  unit?: string;
}

/** A deictic product reference ("អានេះ", "this one", "pic 2"). */
export interface ProductReference {
  /** the normalized text that triggered the reference */
  text: string;
  /** 1-based photo index when the customer pointed at a picture */
  imageIndex?: number;
  /** true when the reference points at a previous purchase ("ដូចមុន") */
  previousPurchase: boolean;
}

export type PrimaryIntent =
  | "purchase"
  | "repeat_purchase"
  | "stock_check"
  | "price_question"
  | "delivery_question"
  | "address"
  | "contact"
  | "confirmation"
  | "negation"
  | "change_request"
  | "hesitation"
  | "photo_request"
  | "interest"
  | "unknown";

/** Confidence that the message expresses an actionable purchase. */
export type ConfidenceBand = "none" | "low" | "medium" | "high";

/**
 * Action identifiers surfaced to the merchant. The UI resolves these through
 * `conversation.intent.actions.*` i18next keys — never hard-code a label.
 */
export type SuggestedActionId =
  | "prepare_order"
  | "check_stock"
  | "send_price"
  | "view_product"
  | "ask_quantity"
  | "ask_variant"
  | "ask_address"
  | "delivery_info"
  | "save_contact"
  | "send_photo"
  | "confirm_change";

export interface IntentResult {
  /** the customer's message exactly as received — never rewritten */
  original: string;
  /** internal normalized form, exposed for debugging and tests */
  normalized: string;
  intent: PrimaryIntent;
  /** distinct signal kinds observed, in first-appearance order */
  signals: SignalKind[];
  items: LineItemCandidate[];
  /** convenience accessors for the first candidate item */
  quantity?: number;
  size?: string;
  color?: string;
  productReference?: ProductReference;
  /** 0..1 purchase-intent confidence */
  confidence: number;
  band: ConfidenceBand;
  /** ordered, de-duplicated action identifiers */
  suggestedActions: SuggestedActionId[];
  /** true only when [Prepare order] may be surfaced */
  prepareOrder: boolean;
  /** negation, change-of-mind, or hesitation was detected */
  negated: boolean;
  /**
   * The message points at something the message itself does not name
   * ("this one", "same as last time"). The caller must resolve it from
   * conversation or order history before pre-filling an order.
   */
  requiresProductResolution: boolean;
  /** phone-like sequences were seen (values are never copied into the result) */
  containsContactDetails: boolean;
  tokens: IntentToken[];
}
