/**
 * App layout route — parent for all /app/* routes.
 *
 * beforeLoad enforces the auth + org guard on the server (SSR) before any child
 * route renders. Never move this logic to useEffect; that would allow the page
 * to flash before redirecting.
 *
 * Guard rules (in order):
 *   1. No session cookie → redirect to /sign-in
 *   2. Email not verified → redirect to /verify-email
 *   3. No active organization membership → redirect to /onboarding
 *   4. Membership suspended or removed → redirect to /access-denied
 *   5. Active membership → allow access; store context in route context
 *
 * The actual guard logic lives in src/api/app-guard.ts (a createServerFn) so that
 * supabaseAdmin (service-role client) stays server-side only and never enters the
 * client bundle. This file itself is safe to bundle for the client.
 */
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { checkAppGuardFn } from "@/api/app-guard";
import { getActiveMemberCapabilitiesFn } from "@/api/capabilities";
import { AppShell } from "@/design-system";
import { CapabilityProvider } from "@/hooks/use-capabilities";
import { enforceApsiCachePrincipal } from "@/lib/apsi-query";
import { enforceHomeCachePrincipal } from "@/lib/home-query";
import { enforceCustomerCachePrincipal } from "@/lib/customers-query";
import { enforceDeliveryCachePrincipal } from "@/lib/deliveries-query";
import { enforceConversationCachePrincipal } from "@/lib/inbox-query";
import { enforceOrderCachePrincipal } from "@/lib/orders-query";
import { enforceTeamCachePrincipal } from "@/lib/team-query";
import type { CapabilityResult } from "@/lib/capabilities";

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    const result = await checkAppGuardFn();

    if (!result.ok) {
      throw redirect({ to: result.redirect });
    }

    return {
      session: result.session,
      organizationId: result.organizationId,
    };
  },

  /*
   * Capability snapshot for the signed-in member, fetched after — never
   * instead of — the guard above. Loading it here rather than from a client
   * effect means the very first paint is already role-correct: no flash of
   * actions the member cannot use, and no flash of an empty shell either.
   *
   * This is presentation data only. It grants nothing; every action behind it
   * is authorized independently on the server.
   */
  loader: async (): Promise<CapabilityResult | null> => {
    try {
      return await getActiveMemberCapabilitiesFn();
    } catch {
      // A capability fetch that fails must never take the whole signed-in
      // shell down with it — the guard above already said this member belongs
      // here. Returning no seed leaves the provider to fetch and report the
      // honest "could not check" state, and the UI fails closed meanwhile.
      return null;
    }
  },

  component: AppLayout,
});

function AppLayout() {
  const { session, organizationId } = Route.useRouteContext();
  const capabilities = Route.useLoaderData();
  const queryClient = useQueryClient();

  /*
   * Home holds another organization's operational data, and one browser tab
   * can serve more than one principal: sign out, sign in as somebody else,
   * or switch the active organization, all without a full page load.
   *
   * This runs during render rather than in an effect on purpose. An effect
   * fires after children have already rendered, which would let Home paint
   * the previous principal's numbers for a frame. Both identifiers come from
   * the server guard's route context, never from client input, and are used
   * only to partition the cache — they authorize nothing.
   */
  enforceHomeCachePrincipal(queryClient, session.userId, organizationId);

  /*
   * The same guarantee, for the five domains migrated in the launch-safety
   * phase. They live here rather than on each route because their data is not
   * confined to one screen: an order list feeds the bottom nav, a customer
   * profile is opened from the Inbox, from Orders and from POS, a delivery is
   * opened from Order detail as well as from its own list, and the Team roster
   * is read by more than /app/team. Enforcing once at the layout means no
   * child route can render a previous principal's payload even for a frame,
   * whichever of them the merchant lands on first.
   *
   * This is also the ONLY thing that covers a sign-out which never runs
   * Settings' purge: when a session expires or is revoked, `beforeLoad` above
   * throws a redirect and nothing clears the cache, yet the router navigates
   * client-side so the tab keeps this same QueryClient. The next member to
   * sign in mounts identical keys. These calls are what stops the previous
   * principal's payload being served to them.
   *
   * Catalog and Inventory keep their existing per-route calls (see
   * src/routes/app.products.tsx, app.inventory.tsx) — this phase does not
   * restructure reviewed, merged code.
   *
   * Every call is a no-op while the principal is unchanged, so ordinary
   * caching within one member's session is untouched.
   */
  enforceOrderCachePrincipal(queryClient, session.userId, organizationId);
  enforceConversationCachePrincipal(queryClient, session.userId, organizationId);
  enforceCustomerCachePrincipal(queryClient, session.userId, organizationId);
  enforceDeliveryCachePrincipal(queryClient, session.userId, organizationId);
  enforceTeamCachePrincipal(queryClient, session.userId, organizationId);
  /*
   * The Apsi console lives in the bottom nav, so it is mounted on every
   * signed-in screen and its answers — customer names, order codes, payment
   * states — outlive any single route. It is partitioned here for exactly the
   * same reason as the five above.
   */
  enforceApsiCachePrincipal(queryClient, session.userId, organizationId);

  return (
    <CapabilityProvider
      userId={session.userId}
      organizationId={organizationId}
      initialResult={capabilities ?? undefined}
    >
      <AppShell>
        <Outlet />
      </AppShell>
    </CapabilityProvider>
  );
}
