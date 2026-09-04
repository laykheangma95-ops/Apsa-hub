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
import { checkAppGuardFn } from "@/api/app-guard";
import { AppShell } from "@/design-system";

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

  component: AppLayout,
});

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
