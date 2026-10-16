import type { UiPermissionKey } from "@/lib/capabilities";

/**
 * Home's four primary starting points, in their fixed 2 × 2 order:
 *
 *   New sale  │ New order
 *   ──────────┼───────────
 *   Pack      │ Inbox
 */
export type HomeQuickActionId = "newSale" | "newOrder" | "packOrders" | "inbox";

export const HOME_QUICK_ACTION_IDS: readonly HomeQuickActionId[] = [
  "newSale",
  "newOrder",
  "packOrders",
  "inbox",
];

/**
 * What tapping a card does. Every target is a flow that already exists — no
 * card points somewhere new, and none is relabelled to stand in for another:
 *
 *   newSale     /app/pos — the POS checkout (the bottom nav's Sales tab).
 *   newOrder    the manual Create Order sheet itself (CreateRealOrderSheet),
 *               opened in place. It used to land on the Orders LIST, which is
 *               one more tap away from the order the card promised.
 *   packOrders  /app/pack — the Ready-to-Pack queue: confirmed orders still to
 *               be packed (listReadyToPack). Not the Orders list's "To pack"
 *               chip, which also holds orders that cannot be packed yet.
 *   inbox       /app/inbox — the unified Inbox (the bottom nav's Inbox tab).
 */
export type HomeQuickActionTarget =
  { kind: "route"; to: "/app/pos" | "/app/pack" | "/app/inbox" } | { kind: "createOrderSheet" };

const TARGET: Record<HomeQuickActionId, HomeQuickActionTarget> = {
  newSale: { kind: "route", to: "/app/pos" },
  newOrder: { kind: "createOrderSheet" },
  packOrders: { kind: "route", to: "/app/pack" },
  inbox: { kind: "route", to: "/app/inbox" },
};

/**
 * The permission each card needs — the SAME key its destination's screen and
 * server functions require, so a card is never a link into a refusal:
 *
 *   newSale     orders.create  POS sells through createOrder (and the nav's
 *                              Sales tab is gated on the same key).
 *   newOrder    orders.create  createOrder; the Orders list's "+" uses it too.
 *   packOrders  orders.read    listReadyToPack (src/server/fulfillment); label
 *                              printing inside re-checks its own narrower key.
 *   inbox       messages.read  every Inbox read.
 *
 * The UI gate is presentation only; the server re-authorizes every call.
 */
const PERMISSION: Record<HomeQuickActionId, UiPermissionKey> = {
  newSale: "orders.create",
  newOrder: "orders.create",
  packOrders: "orders.read",
  inbox: "messages.read",
};

export function homeQuickActionTarget(id: HomeQuickActionId): HomeQuickActionTarget {
  return TARGET[id];
}

export function homeQuickActionPermission(id: HomeQuickActionId): UiPermissionKey {
  return PERMISSION[id];
}

export interface HomeQuickActionState {
  id: HomeQuickActionId;
  target: HomeQuickActionTarget;
  /**
   * False when this member lacks the destination's permission. The card still
   * holds its place in the grid — four squares stay four squares — but renders
   * as a plain, non-interactive tile that says it is not available, never as a
   * button that leads to a refusal.
   */
  available: boolean;
}

/**
 * All four cards with their availability. `can` is the caller's fail-closed
 * capability reader, so an unresolved snapshot offers nothing.
 */
export function homeQuickActions(
  can: (key: UiPermissionKey) => boolean,
): readonly HomeQuickActionState[] {
  return HOME_QUICK_ACTION_IDS.map((id) => ({
    id,
    target: TARGET[id],
    available: can(PERMISSION[id]),
  }));
}
