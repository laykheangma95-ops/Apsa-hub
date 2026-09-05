/**
 * Conversation Smart Actions — bridges the Cambodian intent engine
 * (`@/lib/intent`) to the small, fixed action vocabulary the Conversation
 * screen renders.
 *
 * Pure and client-safe: no network, no server import, no security decision.
 * "The intent/suggestion layer is never security-authoritative" — this module
 * only ever SUGGESTS; every action it names still goes through the same
 * server-authoritative path (customer lookup, catalog validation, order
 * creation) as if the merchant had typed it in by hand.
 *
 * Priority: at most one primary action plus up to two secondary actions,
 * chosen from the intent engine's own ranked `suggestedActions` (see
 * src/lib/intent/detect.ts's confidence model) — this module does not
 * re-derive intent, it only narrows the engine's action vocabulary onto the
 * Conversation screen's smaller, UI-facing vocabulary and applies the two
 * safety overrides below.
 */
import {
  detectConversationIntent,
  resolveAgainstCatalog,
  type ContextMessage,
  type ConversationIntentResult,
  type LineItemCandidate,
  type ResolvedItem,
  type SuggestedActionId,
} from "@/lib/intent";
import type { Product } from "@/types";

/**
 * The Conversation screen's action vocabulary (Smart Actions Phase 1).
 * Deliberately smaller than the engine's `SuggestedActionId`: no
 * `confirm_payment`, `payment_received`, `refund`, `create_delivery`, or
 * `mark_delivered` exists anywhere in this union, so a caller cannot even
 * type one by mistake.
 */
export type SmartActionId =
  | "prepare_order"
  | "repeat_order"
  | "check_stock"
  | "view_product"
  | "ask_quantity"
  | "ask_variant"
  | "ask_address"
  | "view_customer"
  | "send_price"
  | "delivery_info";

export const SMART_ACTION_IDS: readonly SmartActionId[] = [
  "prepare_order",
  "repeat_order",
  "check_stock",
  "view_product",
  "ask_quantity",
  "ask_variant",
  "ask_address",
  "view_customer",
  "send_price",
  "delivery_info",
];

/** One candidate line item, with its (possibly ambiguous) catalog match. */
export interface ResolvedSmartOrderItem {
  candidate: LineItemCandidate;
  resolution: ResolvedItem;
}

export interface SmartActionSuggestion {
  /** null when nothing in the message(s) is worth acting on */
  primary: SmartActionId | null;
  /** at most two, never repeating `primary` */
  secondary: SmartActionId[];
  /** the underlying engine result, exposed for the caller's own edge cases */
  detected: ConversationIntentResult;
  /** catalog-resolved line items, present only when an order action is suggested */
  items: ResolvedSmartOrderItem[];
  /** true when this is a "same as before" request, not a fresh order */
  isRepeat: boolean;
}

/**
 * Maps one engine action to the Conversation vocabulary, or `null` when it has
 * no UI-facing equivalent in this phase (e.g. `send_photo`, `confirm_change` —
 * both real engine outputs, neither built as a Smart Action button yet).
 */
function mapEngineAction(action: SuggestedActionId): SmartActionId | null {
  switch (action) {
    case "prepare_order":
      return "prepare_order";
    case "check_stock":
      return "check_stock";
    case "view_product":
      return "view_product";
    case "ask_quantity":
      return "ask_quantity";
    case "ask_variant":
      return "ask_variant";
    case "ask_address":
      return "ask_address";
    case "send_price":
      return "send_price";
    case "delivery_info":
      return "delivery_info";
    // A phone number or address the customer volunteered is best acted on by
    // opening the customer record, not by inventing a "save_contact" surface.
    case "save_contact":
      return "view_customer";
    // Neither has a safe, unambiguous Smart Action yet (§18 false-positive
    // safety cuts both ways: a photo-send or a mid-correction prompt needs a
    // human reading the thread, not a one-tap button).
    case "send_photo":
    case "confirm_change":
      return null;
    default:
      return null;
  }
}

function dedupe(actions: SmartActionId[]): SmartActionId[] {
  const seen: SmartActionId[] = [];
  for (const action of actions) {
    if (!seen.includes(action)) seen.push(action);
  }
  return seen;
}

export interface BuildSmartActionSuggestionInput {
  /** the conversation window to detect intent from — oldest first */
  messages: ContextMessage[];
  /** false when no customer is linked to this conversation yet */
  hasCustomer: boolean;
  /** the merchant's catalog, used only to resolve variant candidates */
  products: Product[];
}

/**
 * Build the suggestion strip's content for the latest inbound message.
 *
 * Customer linkage is a hard override, not a signal the engine weighs: with no
 * linked customer, `view_customer` is always primary and order-creating
 * actions (`prepare_order` / `repeat_order`) are never offered — "no valid
 * linked customer" must show safe UX, never a guess (see CUSTOMER LINKAGE).
 */
export function buildSmartActionSuggestion(
  input: BuildSmartActionSuggestionInput,
): SmartActionSuggestion {
  const detected = detectConversationIntent(input.messages);
  const resolved = resolveAgainstCatalog(detected.items, input.products);
  const items: ResolvedSmartOrderItem[] = detected.items.map((candidate, index) => ({
    candidate,
    resolution: resolved[index] ?? {
      item: candidate,
      candidateProductIds: [],
      unmatchedAttributes: [],
    },
  }));

  const isRepeat = detected.productReference?.previousPurchase === true;

  let mapped = dedupe(
    detected.suggestedActions
      .map(mapEngineAction)
      .filter((action): action is SmartActionId => action !== null),
  );

  // §1 repeat purchase ("same as before"): offer the dedicated repeat action
  // instead of a blank prepare-order, since resolving it needs the customer's
  // order history, not the catalog.
  if (isRepeat) {
    mapped = mapped.map((action) => (action === "prepare_order" ? "repeat_order" : action));
  }

  if (!input.hasCustomer) {
    // Order-creation needs a linked customer server-side anyway (orders.create
    // validates customer ownership); offering it here would only invite a tap
    // that fails downstream. Everything else in the mapped list still applies.
    mapped = dedupe([
      "view_customer",
      ...mapped.filter((action) => action !== "prepare_order" && action !== "repeat_order"),
    ]);
  }

  const [primary = null, ...rest] = mapped;

  return {
    primary,
    secondary: dedupe(rest).slice(0, 2),
    detected,
    items: primary === "prepare_order" || primary === "repeat_order" ? items : [],
    isRepeat,
  };
}

/** The single catalog product a resolved item unambiguously names, if any. */
export function resolvedProductOf(
  item: ResolvedSmartOrderItem,
  products: Product[],
): Product | undefined {
  if (!item.resolution.productId) return undefined;
  return products.find((product) => product.id === item.resolution.productId);
}

/**
 * One line for the Prepare Order review step. Deliberately decoupled from the
 * intent engine's own types — PrepareOrderSheet only ever needs "how many of
 * which product(s)", regardless of whether that came from a detected message,
 * a repeated order, or (already unambiguous) a single catalog match.
 *
 * `product` and `candidates` are never both set: exactly one product, several
 * to choose from, or neither (search from scratch) — never a guess in between.
 */
export interface PrepareOrderItemInput {
  quantity: number;
  product?: Product;
  candidates?: Product[];
}

/**
 * Converts Smart-Action-resolved items into review-step input. A confident
 * single match becomes a pre-filled line; several matches become a picker;
 * zero matches become a blank line the merchant fills in by search — never a
 * guess (see PRODUCT / VARIANT RESOLUTION: "if multiple product candidates: do
 * not guess").
 */
export function toPrepareOrderItems(
  items: ResolvedSmartOrderItem[],
  products: Product[],
): PrepareOrderItemInput[] {
  return items.map((item) => {
    const quantity = item.candidate.quantity ?? 1;
    const product = resolvedProductOf(item, products);
    if (product) return { quantity, product };

    if (item.resolution.candidateProductIds.length > 1) {
      const candidates = item.resolution.candidateProductIds
        .map((id) => products.find((p) => p.id === id))
        .filter((p): p is Product => Boolean(p));
      return candidates.length > 1 ? { quantity, candidates } : { quantity };
    }

    return { quantity };
  });
}

/**
 * "Repeat order": turn a previous order's lines into review-step input. Each
 * line is matched back to the CURRENT catalog by id — a product that was
 * renamed, repriced, or discontinued since is reflected honestly (current
 * name/price when still found, a blank line to re-pick when not), never the
 * stale snapshot the old order recorded.
 */
export function toRepeatOrderItems(
  previousItems: Array<{ productId: string; quantity: number }>,
  products: Product[],
): PrepareOrderItemInput[] {
  return previousItems.map(({ productId, quantity }) => {
    const product = products.find((p) => p.id === productId);
    return product ? { quantity, product } : { quantity };
  });
}
