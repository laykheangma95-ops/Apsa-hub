import type { AttentionItem, HomeSummary } from "@/types";
import type { UiPermissionKey } from "@/lib/capabilities";

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
 * Deliberately carries NO search-param filter. Every count Home shows is a
 * UNION its destination's filter vocabulary cannot express in one server
 * query:
 *
 *   awaiting_payment        orders with payment_status unpaid OR pending
 *   payments_needing_review mismatch OR duplicate_suspected OR pending+unverified
 *   low_stock               quantity <= 0, i.e. the zero AND negative filters
 *
 * Pre-selecting the nearest single filter would land the merchant on a
 * SHORTER list than the number they just tapped — a filter that contradicts
 * its own entry point is worse than no filter. Each destination surfaces the
 * same work through its own attention band, review markers and chips.
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

/** The destination for an attention row, or null when it has none. */
export function attentionRoute(id: AttentionItem["id"]): AttentionRoute | null {
  return ATTENTION_ROUTE[id] ?? null;
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
): AttentionRoute | null {
  const route = attentionRoute(id);
  if (!route) return null;
  return can(attentionRoutePermission(route)) ? route : null;
}
