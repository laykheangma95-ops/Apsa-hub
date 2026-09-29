/**
 * The one client-facing capability access pattern.
 *
 * `useCapabilities()` returns a fail-closed reader over the server-derived
 * snapshot for the authenticated member's active organization. Components call
 * `can("orders.refund")` to decide what to render — never to decide access.
 * The server authorizes every action again on its own.
 *
 * Outside a provider the default view is "pending", so nothing is offered.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { getActiveMemberCapabilitiesFn } from "@/api/capabilities";
import {
  capabilityQueryKey,
  createCapabilityView,
  createFixtureCapabilityView,
  UNRESOLVED_CAPABILITIES,
  type CapabilityResult,
  type CapabilityView,
  type UiPermissionKey,
} from "@/lib/capabilities";

const CapabilityContext = createContext<CapabilityView>(UNRESOLVED_CAPABILITIES);

/** Re-fetch rather than trust a long-lived snapshot: access can be revoked. */
const CAPABILITY_STALE_MS = 60_000;

/**
 * How often a surface that displays sensitive data re-asks the server whether
 * access still holds, while it is open. staleTime alone never triggers a
 * refetch, so without this an already-open view would learn of a server-side
 * revocation only by unrelated navigation or focus changes.
 */
export const SENSITIVE_CAPABILITY_REVALIDATE_MS = 15_000;

interface CapabilityProviderProps {
  /** From the /app route context — validated server-side, never from the URL. */
  userId: string;
  /** From the /app route context — resolved from DB membership, never from the client. */
  organizationId: string;
  /** SSR seed from the /app loader, so the first paint is already role-correct. */
  initialResult?: CapabilityResult | undefined;
  children: ReactNode;
}

export function CapabilityProvider({
  userId,
  organizationId,
  initialResult,
  children,
}: CapabilityProviderProps) {
  const query = useQuery({
    // Partitioned by user AND organization: a snapshot can never be read back
    // for a different account or a different organization.
    queryKey: capabilityQueryKey(userId, organizationId),
    queryFn: () => getActiveMemberCapabilitiesFn(),
    ...(initialResult ? { initialData: initialResult } : {}),
    staleTime: CAPABILITY_STALE_MS,
    retry: false,
  });

  const view = useMemo(
    () =>
      createCapabilityView({
        result: query.data,
        isPending: query.isPending,
        isError: query.isError,
        expectedUserId: userId,
        expectedOrganizationId: organizationId,
      }),
    [query.data, query.isPending, query.isError, userId, organizationId],
  );

  return <CapabilityContext.Provider value={view}>{children}</CapabilityContext.Provider>;
}

/**
 * Keep the ONE production capability query fresh while a sensitive surface is
 * open. Same query key and queryFn as CapabilityProvider (so there is a single
 * source of truth and one request per tick); the provider's view — and with it
 * canSensitive() — updates from the result. A failed refresh leaves the
 * snapshot `stale`, which canSensitive() refuses. Polls only while `active`.
 */
export function useSensitiveCapabilityRevalidation(
  userId: string,
  organizationId: string,
  active: boolean,
): void {
  useQuery({
    queryKey: capabilityQueryKey(userId, organizationId),
    queryFn: () => getActiveMemberCapabilitiesFn(),
    enabled: active,
    // Always treat the held snapshot as stale: refetch on open/mount and focus.
    staleTime: 0,
    refetchInterval: active ? SENSITIVE_CAPABILITY_REVALIDATE_MS : false,
    refetchIntervalInBackground: true,
    retry: false,
  });
}

/**
 * Fresh, server-authoritative check that `key` still holds — for the moment
 * before an irreversible sensitive action (printing). Cancels any in-flight
 * capability request (which may predate a revocation), refetches, and reads the
 * outcome. Fails closed: an error, a non-active result, another principal's
 * snapshot, or a missing key all return false. Never throws.
 */
export async function reauthorizeCapability(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
  key: UiPermissionKey,
): Promise<boolean> {
  try {
    const queryKey = capabilityQueryKey(userId, organizationId);
    await queryClient.refetchQueries({ queryKey, exact: true }, { cancelRefetch: true });
    const state = queryClient.getQueryState<CapabilityResult>(queryKey);
    const result = state?.data;
    return (
      state?.status === "success" &&
      !!result &&
      result.status === "active" &&
      result.userId === userId &&
      result.organizationId === organizationId &&
      result.permissions.includes(key)
    );
  } catch {
    return false;
  }
}

/**
 * Render children against an explicit permission list.
 *
 * Design-gallery and test scaffolding ONLY — it bypasses the server snapshot,
 * so it must never appear on an /app route. src/tests/capability-boundary.test.ts
 * enforces that.
 */
export function CapabilityFixtureProvider({
  permissions,
  role = null,
  children,
}: {
  permissions: readonly UiPermissionKey[];
  role?: string | null;
  children: ReactNode;
}) {
  const view = useMemo(() => createFixtureCapabilityView(permissions, role), [permissions, role]);
  return <CapabilityContext.Provider value={view}>{children}</CapabilityContext.Provider>;
}

export function useCapabilities(): CapabilityView {
  return useContext(CapabilityContext);
}
