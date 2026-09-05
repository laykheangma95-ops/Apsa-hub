/**
 * Deterministic intent detection for Cambodian commerce chat.
 *
 * The engine composes meaning from small signals (§19 confidence model): a
 * purchase verb, an identified product, a quantity, and a variant reinforce each
 * other, while negation and change-of-mind suppress the order suggestion (§12,
 * §18). It never rewrites the customer's message and never decides anything
 * about money, payment, or delivery execution.
 */
import { groupItems } from "./items";
import { normalizeMessage } from "./normalize";
import { scan } from "./scan";
import type {
  ConfidenceBand,
  IntentResult,
  IntentToken,
  PrimaryIntent,
  ProductReference,
  SignalKind,
  SuggestedActionId,
} from "./types";

/** Tunable weights — exported so tests can assert the model, not magic numbers. */
export const CONFIDENCE = {
  purchaseVerb: 50,
  repeatOnly: 45,
  repeatWithPurchase: 8,
  productReference: 15,
  weakProductReference: 8,
  color: 10,
  size: 10,
  quantity: 12,
  countMarker: 3,
  confirmation: 4,
  interest: 3,
  /** two or more fully-counted line items is an order shape on its own */
  multiItem: 25,
  /** pointing at a product and counting it ("អានេះ 2 pcs") */
  countedReference: 18,
  /** ceiling applied once negation / change-of-mind / hesitation is present */
  negatedCeiling: 30,
  bands: { high: 70, medium: 45, low: 20 },
  /** [Prepare order] is never surfaced below this score */
  prepareOrderFloor: 45,
} as const;

const MAX_ACTIONS = 3;

/** Negation reaches forward over roughly one Khmer phrase. */
const NEGATION_REACH = 8;

export interface DetectOptions {
  /** true when this message is part of a bounded multi-message window (§17) */
  fragmentContext?: boolean;
}

function bandFor(score: number): ConfidenceBand {
  if (score >= CONFIDENCE.bands.high) return "high";
  if (score >= CONFIDENCE.bands.medium) return "medium";
  if (score >= CONFIDENCE.bands.low) return "low";
  return "none";
}

function weightOf(tokens: IntentToken[], kind: SignalKind): number {
  return tokens
    .filter((token) => token.kinds.includes(kind))
    .reduce((total, token) => total + (token.weight ?? 1), 0);
}

/** Drop purchase verbs that a negation immediately governs ("មិន" + "ចង់បាន"). */
function applyNegationScope(tokens: IntentToken[]): IntentToken[] {
  const negations = tokens.filter((token) => token.kinds.includes("negate"));
  if (negations.length === 0) return tokens;

  return tokens.map((token) => {
    if (!token.kinds.includes("purchase")) return token;
    const governed = negations.some(
      (negation) => negation.end <= token.start && token.start - negation.end <= NEGATION_REACH,
    );
    return governed ? { ...token, kinds: ["ignored" as SignalKind] } : token;
  });
}

function productReferenceOf(tokens: IntentToken[], repeat: boolean): ProductReference | undefined {
  const ref = tokens.find((token) => token.kinds.includes("product_ref"));
  const imageToken = tokens.find((token) => token.kinds.includes("image_index"));
  if (!ref && !imageToken && !repeat) return undefined;

  return {
    text: ref?.text ?? imageToken?.text ?? "",
    ...(typeof imageToken?.value === "number" ? { imageIndex: imageToken.value } : {}),
    previousPurchase: repeat,
  };
}

function distinctSignals(tokens: IntentToken[]): SignalKind[] {
  const seen: SignalKind[] = [];
  for (const token of tokens) {
    for (const kind of token.kinds) {
      if (kind === "ignored" || kind === "number") continue;
      if (!seen.includes(kind)) seen.push(kind);
    }
  }
  return seen;
}

/** Detect commerce intent in a single customer message. */
export function detectIntent(message: string, options: DetectOptions = {}): IntentResult {
  const normalized = normalizeMessage(message);
  const rawTokens = scan(normalized, { fragmentContext: options.fragmentContext ?? false });
  const tokens = applyNegationScope(rawTokens);

  const present = (kind: SignalKind) => tokens.some((token) => token.kinds.includes(kind));

  const items = groupItems(tokens);
  const firstItem = items[0];

  const hasPurchaseVerb = present("purchase");
  const hasSendRequest = present("send_request");
  const hasRepeat = present("repeat");
  const hasStock = present("stock");
  const hasPrice = present("price");
  const hasDiscount = present("discount");
  const hasDelivery = present("delivery");
  const hasAddress = present("address");
  const hasPhone = present("phone");
  const hasConfirm = present("confirm");
  const hasNegate = present("negate");
  const hasChange = present("change");
  // A weak hesitation marker ("សិន") is ignored when the customer also used a
  // purchase verb.
  const hasHesitate = tokens.some(
    (token) =>
      token.kinds.includes("hesitate") && ((token.weight ?? 1) >= 1 || !present("purchase")),
  );
  const hasInterest = present("interest");
  const hasPhotoRequest = present("photo_request");
  const hasCountMarker = present("unit") || present("multiplier") || present("qty_marker");

  const colorSeen = items.some((item) => item.color !== undefined);
  const sizeSeen = items.some((item) => item.size !== undefined);
  const quantitySeen = items.some((item) => item.quantity !== undefined);

  // §9: "location ដដែល" is a repeated ADDRESS, not a repeat purchase. A repeat
  // is also not a purchase when the customer is only asking about price/stock
  // ("តម្លៃដដែល?").
  const repeatPurchase =
    hasRepeat && !hasAddress && (hasPurchaseVerb || (!hasPrice && !hasStock && !hasDelivery));

  // "ផ្ញើ" / "send" only means "order this" when no address is in play and the
  // customer is not asking for a photo.
  const sendAsPurchase =
    hasSendRequest &&
    !hasAddress &&
    !hasPhotoRequest &&
    (items.length > 0 || present("product_ref"));

  const multiItemOrder = items.length >= 2 && items.every((item) => item.quantity !== undefined);

  const strongProductRef = tokens.some(
    (token) => token.kinds.includes("product_ref") && (token.weight ?? 1) >= 1,
  );
  const weakRefOnly = present("product_ref") && !strongProductRef;

  // §3: "អានេះ 2 pcs" — pointing at a product and counting it is an order shape,
  // but only when the message is not a price / stock / delivery question.
  const countedReference =
    strongProductRef && quantitySeen && !hasPrice && !hasStock && !hasDelivery && !hasDiscount;

  const purchaseIntent =
    hasPurchaseVerb || repeatPurchase || sendAsPurchase || multiItemOrder || countedReference;

  const productReference = productReferenceOf(tokens, repeatPurchase);
  const productIdentified = Boolean(productReference) || colorSeen || sizeSeen;

  const negated = hasNegate || hasChange || hasHesitate;

  let score = 0;
  if (hasPurchaseVerb || sendAsPurchase) score += CONFIDENCE.purchaseVerb;
  if (repeatPurchase) {
    score += hasPurchaseVerb ? CONFIDENCE.repeatWithPurchase : CONFIDENCE.repeatOnly;
  }
  if (present("product_ref")) {
    score += weakRefOnly ? CONFIDENCE.weakProductReference : CONFIDENCE.productReference;
  }
  if (colorSeen) score += CONFIDENCE.color;
  if (sizeSeen) score += CONFIDENCE.size;
  if (quantitySeen) score += CONFIDENCE.quantity;
  if (hasCountMarker) score += CONFIDENCE.countMarker;
  if (hasConfirm) score += CONFIDENCE.confirmation;
  if (hasInterest) score += CONFIDENCE.interest;
  if (multiItemOrder) score += CONFIDENCE.multiItem;
  if (countedReference) score += CONFIDENCE.countedReference;

  score = Math.min(100, score);
  if (negated) score = Math.min(score, CONFIDENCE.negatedCeiling);

  const band = bandFor(score);
  const prepareOrder =
    purchaseIntent && productIdentified && !negated && score >= CONFIDENCE.prepareOrderFloor;

  const stockWeight = weightOf(tokens, "stock");
  const priceWeight = weightOf(tokens, "price") + weightOf(tokens, "discount");

  const intent = primaryIntent({
    hasNegate,
    hasChange,
    hasHesitate,
    purchaseIntent,
    repeatPurchase,
    hasPurchaseVerb: hasPurchaseVerb || sendAsPurchase || multiItemOrder || countedReference,
    hasDelivery,
    hasPhotoRequest,
    hasPhone,
    hasAddress,
    hasStock,
    hasPrice: hasPrice || hasDiscount,
    hasInterest,
    hasConfirm,
    stockWeight,
    priceWeight,
    hasVariant: colorSeen || sizeSeen,
    hasProductRef: present("product_ref"),
  });

  const suggestedActions = suggestActions({
    intent,
    prepareOrder,
    purchaseIntent,
    productIdentified,
    quantitySeen,
    variantSeen: colorSeen || sizeSeen,
    negated,
    hasStock,
    hasPrice: hasPrice || hasDiscount,
    hasDelivery,
    hasAddress,
    hasPhone,
    hasPhotoRequest,
  });

  return {
    original: message,
    normalized,
    intent,
    signals: distinctSignals(tokens),
    items,
    ...(firstItem?.quantity !== undefined ? { quantity: firstItem.quantity } : {}),
    ...(firstItem?.size !== undefined ? { size: firstItem.size } : {}),
    ...(firstItem?.color !== undefined ? { color: firstItem.color } : {}),
    ...(productReference ? { productReference } : {}),
    confidence: score / 100,
    band,
    suggestedActions,
    prepareOrder,
    negated,
    requiresProductResolution:
      Boolean(productReference) || (purchaseIntent && !colorSeen && !sizeSeen),
    containsContactDetails: tokens.some((token) => token.kinds.includes("phone")),
    tokens,
  };
}

interface IntentInputs {
  hasNegate: boolean;
  hasChange: boolean;
  hasHesitate: boolean;
  purchaseIntent: boolean;
  repeatPurchase: boolean;
  hasPurchaseVerb: boolean;
  hasDelivery: boolean;
  hasPhotoRequest: boolean;
  hasPhone: boolean;
  hasAddress: boolean;
  hasStock: boolean;
  hasPrice: boolean;
  hasInterest: boolean;
  hasConfirm: boolean;
  stockWeight: number;
  priceWeight: number;
  hasVariant: boolean;
  hasProductRef: boolean;
}

function primaryIntent(input: IntentInputs): PrimaryIntent {
  if (input.hasNegate) return input.hasPurchaseVerb ? "change_request" : "negation";
  if (input.hasChange) return "change_request";
  // An explicit photo request survives a hesitation marker: the merchant can
  // still send the photo, it just is not an order.
  if (input.hasPhotoRequest) return "photo_request";
  if (input.hasHesitate) return "hesitation";
  if (input.purchaseIntent) return input.repeatPurchase ? "repeat_purchase" : "purchase";
  if (input.hasDelivery) return "delivery_question";
  if (input.hasPhone) return "contact";
  if (input.hasAddress && !input.hasStock && !input.hasPrice) return "address";
  if (input.hasStock && input.stockWeight >= input.priceWeight) return "stock_check";
  if (input.hasPrice) return "price_question";
  if (input.hasStock) return "stock_check";
  if (input.hasInterest) return "interest";
  // A politeness confirmation ("អូខេបង") must not outrank a stated variant.
  if (input.hasVariant) return "stock_check";
  if (input.hasConfirm) return "confirmation";
  if (input.hasProductRef) return "interest";
  return "unknown";
}

interface ActionInputs {
  intent: PrimaryIntent;
  prepareOrder: boolean;
  purchaseIntent: boolean;
  productIdentified: boolean;
  quantitySeen: boolean;
  variantSeen: boolean;
  negated: boolean;
  hasStock: boolean;
  hasPrice: boolean;
  hasDelivery: boolean;
  hasAddress: boolean;
  hasPhone: boolean;
  hasPhotoRequest: boolean;
}

function suggestActions(input: ActionInputs): SuggestedActionId[] {
  const actions: SuggestedActionId[] = [];
  const push = (action: SuggestedActionId) => {
    if (!actions.includes(action)) actions.push(action);
  };

  switch (input.intent) {
    case "purchase":
    case "repeat_purchase":
      if (input.prepareOrder) {
        push("prepare_order");
        if (!input.quantitySeen) push("ask_quantity");
        if (!input.variantSeen) push("ask_variant");
      } else if (input.purchaseIntent && !input.productIdentified) {
        push("ask_variant");
        push("view_product");
      } else {
        push("check_stock");
        push("view_product");
      }
      break;
    case "stock_check":
      push("check_stock");
      break;
    case "price_question":
      push("send_price");
      break;
    case "delivery_question":
      push("delivery_info");
      if (!input.hasAddress) push("ask_address");
      break;
    case "address":
    case "contact":
      push("save_contact");
      break;
    case "photo_request":
      push("send_photo");
      break;
    case "change_request":
      push("confirm_change");
      break;
    case "hesitation":
      push("view_product");
      break;
    case "interest":
      push("view_product");
      break;
    case "negation":
    case "confirmation":
    case "unknown":
      break;
  }

  // Secondary signals in the same message still deserve an action — §18 prefers
  // several safe suggestions over one risky one.
  if (!input.negated) {
    if (input.hasStock) push("check_stock");
    if (input.hasPrice) push("send_price");
    if (input.hasDelivery) push("delivery_info");
    if (input.hasPhone) push("save_contact");
    if (input.hasPhotoRequest) push("send_photo");
    if (actions.length === 0) {
      if (input.intent === "interest" || input.productIdentified) push("view_product");
      else if (input.quantitySeen) push("ask_variant");
    }
  }

  return actions.slice(0, MAX_ACTIONS);
}
