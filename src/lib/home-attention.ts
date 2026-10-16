import type { AttentionItem, HomeSummary } from "@/types";
import type { UiPermissionKey } from "@/lib/capabilities";
import type { OrderListFilter } from "@/lib/order-list-filters";

/**
 * The Home sections that can contribute a "needs attention" row. Finance is
 * deliberately absent: it is a period total in the overview, not work queued
 * for the merchant.
 */
export const ATTENTION_SECTIONS = ["orders", "payments", "inventory", "delivery"] as const;

/**
 * How much of the attention picture Home actually has.
 *
 * - `complete`    — every section the member can access answered successfully.
 * - `incomplete`  — at least one accessible section errored or was truncated,
 *                   so an empty list means "not known", not "nothing to do".
 * - `unavailable` — the member can access none of the attention sections, so
 *                   Home has nothing to be silent or reassuring about.
 */
export type AttentionCompleteness = "complete" | "incomplete" | "unavailable";

/**
 * A denied section is a normal, permission-aware partial view — never an
 * error, and never a reason to withhold a truthful "nothing needs attention"
 * from the sections the member can actually see.
 */
export function attentionCompleteness(summary: HomeSummary): AttentionCompleteness {
  let accessible = 0;
  let unfinished = 0;

  for (const section of ATTENTION_SECTIONS) {
    const status = summary[section].status;
    if (status === "permission_denied") continue;
    accessible += 1;
    // "error" and "truncated" both mean the count Home holds is not the count
    // that exists, so neither may be reported as a settled zero.
    if (status !== "available") unfinished += 1;
  }

  if (accessible === 0) return "unavailable";
  return unfinished > 0 ? "incomplete" : "complete";
}

/**
 * The single line under the attention list, or `null` when the cards speak for
 * themselves. Returning a key rather than a string keeps the decision testable
 * and the copy in the locale files.
 *
 * The clean zero-attention claim is reachable through exactly one path: no
 * attention rows AND a complete picture.
 */
export function attentionNoticeKey(
  summary: HomeSummary,
  attentionCount: number,
): "home.noAttention" | "home.attentionIncomplete" | "home.attentionUnavailable" | null {
  const completeness = attentionCompleteness(summary);

  if (completeness === "unavailable") return "home.attentionUnavailable";
  // Said whether or not rows are showing: a partial list is still partial.
  if (completeness === "incomplete") return "home.attentionIncomplete";
  return attentionCount === 0 ? "home.noAttention" : null;
}

// ── Where an attention row takes the merchant ────────────────────────────────

/** Every destination an attention row may point at. */
export type AttentionRoute =
  "/app/inbox" | "/app/orders" | "/app/deliveries" | "/app/payments" | "/app/inventory";

/**
 * The screen that OWNS each kind of attention work — not merely one that
 * mentions it. Payment review is decided on /app/payments (confirm, verify,
 * refund); an out-of-stock count is resolved on /app/inventory.
 *
 * The route alone; a pre-selected filter is ATTENTION_ORDER_FILTER's job, and
 * only Orders has one.
 */
const ATTENTION_ROUTE: Partial<Record<AttentionItem["id"], AttentionRoute>> = {
  unread_conversations: "/app/inbox",
  awaiting_payment: "/app/orders",
  payments_needing_review: "/app/payments",
  awaiting_delivery: "/app/deliveries",
  orders_needing_action: "/app/orders",
  low_stock: "/app/inventory",
};

/**
 * The permission each destination needs — the same key its screen and its
 * server functions require. A member without it still sees the count (it is
 * their own organization's work) but is not offered a link to somewhere the
 * server will refuse them.
 */
const ATTENTION_PERMISSION: Record<AttentionRoute, UiPermissionKey> = {
  "/app/inbox": "messages.read",
  "/app/orders": "orders.read",
  "/app/deliveries": "delivery.read",
  "/app/payments": "payments.read",
  "/app/inventory": "inventory.read",
};

/**
 * The Orders filter an attention row opens on — only where the filter selects
 * EXACTLY the orders Home counted, so the list the merchant lands on is the
 * number they tapped:
 *
 *   awaiting_payment  Home counts lifecycle not cancelled AND payment unpaid or
 *                     pending (src/server/home/repository.ts). The
 *                     awaiting_payment filter is that predicate, column for
 *                     column (src/lib/order-list-filters.ts).
 *
 * orders_needing_action has no filter on purpose. Home counts lifecycle not
 * cancelled AND (draft OR fulfillment unfulfilled): every draft, plus every
 * live order not yet packed. That is Drafts AND To pack together (and, at the
 * edges, a draft whose fulfillment was cancelled, which the chips file under
 * Cancelled). One chip shows one of them, so any filter would land on FEWER
 * orders than the number just tapped. The row opens All, which holds every one
 * of them. A filter for that union is a product decision, not a link.
 *
 * Every other row goes to a screen whose filters cannot express its count in
 * one server query, so it carries none:
 *
 *   payments_needing_review mismatch OR duplicate_suspected OR pending+unverified
 *   low_stock               quantity <= 0, i.e. the zero AND negative filters
 *
 * A filter that contradicts its own entry point is worse than no filter. Each
 * of those screens surfaces the same work through its own attention band,
 * review markers and chips.
 */
const ATTENTION_ORDER_FILTER: Partial<Record<AttentionItem["id"], OrderListFilter>> = {
  awaiting_payment: "awaiting_payment",
};

/** Where an attention row may lead: a screen, and for Orders, the filter it opens on. */
export type AttentionDestination =
  | { to: "/app/orders"; search: { filter?: OrderListFilter } }
  | { to: Exclude<AttentionRoute, "/app/orders"> };

/** The screen for an attention row, or null when it has none. */
export function attentionRoute(id: AttentionItem["id"]): AttentionRoute | null {
  return ATTENTION_ROUTE[id] ?? null;
}

/** The Orders filter an attention row opens on, or null for the whole list (All). */
export function attentionOrderFilter(id: AttentionItem["id"]): OrderListFilter | null {
  return ATTENTION_ORDER_FILTER[id] ?? null;
}

/** The permission a destination requires. */
export function attentionRoutePermission(route: AttentionRoute): UiPermissionKey {
  return ATTENTION_PERMISSION[route];
}

/**
 * Where tapping this attention row should go, or null when it must not be a
 * link at all — either because nothing owns that work yet, or because this
 * member cannot enter the screen that does.
 *
 * `can` is the caller's fail-closed capability reader, so an unresolved
 * snapshot yields a non-link rather than a link into a refusal.
 */
export function attentionDestination(
  id: AttentionItem["id"],
  can: (key: UiPermissionKey) => boolean,
): AttentionDestination | null {
  const route = attentionRoute(id);
  if (!route || !can(attentionRoutePermission(route))) return null;
  if (route !== "/app/orders") return { to: route };
  // An explicit search either way: All is the absence of `filter`, so this
  // row never inherits a filter from wherever the merchant last was.
  const filter = attentionOrderFilter(id);
  return { to: route, search: filter ? { filter } : {} };
}
