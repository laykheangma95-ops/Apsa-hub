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
import { enforceHomeCachePrincipal } from "@/lib/home-query";
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
