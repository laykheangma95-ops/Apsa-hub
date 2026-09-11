/**
 * UI capability model — presentation only.
 *
 * This module is deliberately dumb. It holds no role matrix, derives nothing
 * from a role name, and grants nothing: it is a typed container for the
 * permission keys the SERVER already resolved for the authenticated member,
 * plus a fail-closed reader the UI uses to decide what to show.
 *
 * Authorization itself never happens here. Every action the UI exposes is
 * still authorized independently by the server (AuthorizationContext.require /
 * .can in src/server/**). Hiding a button is a courtesy, not a control.
 *
 * Safe to bundle for the browser — no Supabase, no server imports, no secrets.
 */

/**
 * The permission keys the UI is allowed to ask about.
 *
 * Every key here is already enforced server-side today (grep for ctx.require /
 * ctx.can in src/server/**). The server returns only the intersection of this
 * list and the member's resolved permissions, so the browser never receives the
 * full internal permission set — only the bits this UI actually consults.
 *
 * Adding a key here without a matching server-side check is a bug: it would
 * create a UI-only gate that pretends to be authorization.
 */
export const UI_PERMISSION_KEYS = [
  // Inbox / conversations — src/server/conversations/service.ts
  "messages.read",
  "messages.reply",
  // Orders — src/server/orders/service.ts (confirm/cancel via the lifecycle
  // transition map in src/server/orders/state-machine.ts)
  "orders.read",
  "orders.create",
  "orders.confirm",
  "orders.cancel",
  // Refunds are a Payment-domain action: refundPayment requires payments.refund
  // (src/server/payments/service.ts). The historical orders.refund key no
  // longer authorizes anything, so the UI must not gate on it.
  "payments.refund",
  // Customers — src/server/customers/service.ts
  "customers.read",
  "customers.view_sensitive",
  // Products — src/server/products/service.ts
  "products.create",
  // Delivery — src/server/deliveries/service.ts
  "delivery.read",
  // Team — src/server/team/service.ts
  "team.read",
  "team.invite",
  "team.roles_assign",
  "team.remove",
  // Organization — src/server/org/get-organization-profile.ts
  "organization.read",
] as const;

export type UiPermissionKey = (typeof UI_PERMISSION_KEYS)[number];

const UI_PERMISSION_KEY_SET: ReadonlySet<string> = new Set<string>(UI_PERMISSION_KEYS);

/** True when `key` is one of the keys this UI is allowed to consult. */
export function isUiPermissionKey(key: string): key is UiPermissionKey {
  return UI_PERMISSION_KEY_SET.has(key);
}

/**
 * Why a member has no capability snapshot. Never carries organization data —
 * a denial must not leak what exists on the other side of it.
 */
export type CapabilityDenialReason = "unauthenticated" | "email_unverified" | "no_membership";

export interface CapabilitySnapshot {
  status: "active";
  /** The authenticated user, as validated by the server from the session cookie. */
  userId: string;
  /** Resolved from the member's own active DB membership — never from the client. */
  organizationId: string;
  /** Stored system role (OWNER/MANAGER/...) or null. Display only — grants nothing. */
  role: string | null;
  permissions: readonly UiPermissionKey[];
}

export type CapabilityResult = CapabilitySnapshot | { status: CapabilityDenialReason };

// ── React Query cache identity ───────────────────────────────────────────────
//
// Partitioned by authenticated user AND active organization so a snapshot can
// never be reused across an account switch or an organization switch. Both
// values come from the server-derived /app route context, never from the URL
// or any client input.

export const CAPABILITY_QUERY_ROOT = "capabilities";

export function capabilityQueryKey(
  userId: string,
  organizationId: string,
): readonly [typeof CAPABILITY_QUERY_ROOT, string, string] {
  return [CAPABILITY_QUERY_ROOT, userId, organizationId] as const;
}

// ── The fail-closed reader ───────────────────────────────────────────────────

/**
 * "pending" — still resolving; "denied" — resolved to no usable membership, or
 * unresolvable (error, identity mismatch); "ready" — a trustworthy snapshot.
 *
 * can() returns false in every state except "ready". A caller that wants a
 * skeleton rather than a denial while resolving branches on `state` itself.
 */
export type CapabilityState = "pending" | "denied" | "ready";

export interface CapabilityView {
  state: CapabilityState;
  /** Server-derived role label, for display only. null unless state is "ready". */
  role: string | null;
  /** null unless state is "ready". */
  organizationId: string | null;
  /** Present only when the member is resolved but has no usable membership. */
  reason: CapabilityDenialReason | "unavailable" | null;
  can(key: UiPermissionKey): boolean;
  canAll(keys: readonly UiPermissionKey[]): boolean;
  canAny(keys: readonly UiPermissionKey[]): boolean;
}

function buildView(
  state: CapabilityState,
  reason: CapabilityView["reason"],
  snapshot: CapabilitySnapshot | null,
): CapabilityView {
  const granted: ReadonlySet<string> =
    state === "ready" && snapshot ? new Set<string>(snapshot.permissions) : new Set<string>();

  const can = (key: UiPermissionKey): boolean => granted.has(key);

  return {
    state,
    reason,
    role: state === "ready" && snapshot ? snapshot.role : null,
    organizationId: state === "ready" && snapshot ? snapshot.organizationId : null,
    can,
    canAll: (keys) => keys.length > 0 && keys.every(can),
    canAny: (keys) => keys.some(can),
  };
}

/** Nothing is known, so nothing is offered. The default everywhere. */
export const UNRESOLVED_CAPABILITIES: CapabilityView = buildView("pending", null, null);

export interface CapabilityViewInput {
  result: CapabilityResult | undefined;
  isPending: boolean;
  isError: boolean;
  /** Identity the snapshot must belong to — from the server-derived route context. */
  expectedUserId: string;
  expectedOrganizationId: string;
}

/**
 * Turn a query state into a capability view.
 *
 * The identity check is the tenant guard: a snapshot is only honoured when it
 * describes exactly the user and organization the caller was mounted for. A
 * stale snapshot from a previous account or organization therefore cannot
 * grant anything, even if it somehow survived a cache clear.
 */
export function createCapabilityView(input: CapabilityViewInput): CapabilityView {
  /*
   * No snapshot at all: pending while the first fetch is in flight, denied
   * once it has settled without one (including a hard fetch failure).
   *
   * A snapshot we already hold survives a failed BACKGROUND refetch, and only
   * that: on a patchy mobile connection, emptying the merchant's navigation
   * every time a refresh times out would be its own defect, and the snapshot
   * is still the last thing the server actually said about this exact member.
   * Revocation does not come through this path — a revoked member gets a
   * successful response saying "no_membership", handled below.
   */
  if (!input.result) {
    if (input.isError) return buildView("denied", "unavailable", null);
    return input.isPending ? UNRESOLVED_CAPABILITIES : buildView("denied", "unavailable", null);
  }

  const result = input.result;
  if (result.status !== "active") return buildView("denied", result.status, null);

  if (
    result.userId !== input.expectedUserId ||
    result.organizationId !== input.expectedOrganizationId
  ) {
    return buildView("denied", "unavailable", null);
  }

  // Defence in depth: ignore anything outside the declared UI vocabulary.
  const permissions = result.permissions.filter(isUiPermissionKey);
  return buildView("ready", null, { ...result, permissions });
}

/**
 * Build a view from an explicit permission list.
 *
 * NOT an authorization path — it never consults a session and never decides
 * access. It exists so the design gallery and unit tests can render capability
 * -aware components deterministically. Production code must use the provider,
 * which is fed by the server function; the capability-boundary test enforces that.
 */
export function createFixtureCapabilityView(
  permissions: readonly UiPermissionKey[],
  role: string | null = null,
): CapabilityView {
  return buildView("ready", null, {
    status: "active",
    userId: "fixture",
    organizationId: "fixture",
    role,
    permissions,
  });
}
