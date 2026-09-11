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
import { useQuery } from "@tanstack/react-query";
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
