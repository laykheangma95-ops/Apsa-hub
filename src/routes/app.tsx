/**
 * /app layout route — server-side session guard.
 *
 * This file is the layout for ALL /app/* routes (app.index.tsx, app.inbox.tsx, etc.).
 * Its beforeLoad runs on EVERY navigation to any /app/ route, on both SSR and
 * client-side transitions.
 *
 * Protection guarantee:
 *   - Direct URL navigation:   SSR runs beforeLoad → server reads cookie → redirect if invalid
 *   - Browser refresh:          same as direct navigation
 *   - SPA navigation to /app:  client calls getSessionFn (HTTP to server) → server reads cookie
 *   - Unauthenticated:         → /sign-in
 *   - Unverified email:        → /verify-email
 *   - Authenticated, no org:   → /onboarding
 *   - Revoked membership:      → sign-out + /access-denied (no loop)
 *   - Active member:           → renders layout + child route
 *
 * The client Supabase session (localStorage) MAY be used for reactive UI
 * but is NOT the security authority. The server cookie check is.
 */

import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getSessionFn, clearAuthCookieFn } from "@/api/auth";

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    const session = await getSessionFn();

    switch (session.status) {
      case "unauthenticated":
        throw redirect({ to: "/sign-in" });

      case "unverified":
        throw redirect({ to: "/verify-email" });

      case "no_org":
        throw redirect({ to: "/onboarding" });

      case "revoked":
        // Sign the user out server-side (clear cookie), then redirect to stable page.
        // This breaks the redirect loop: revoked user → access-denied (no session in cookie)
        // → /sign-in if they navigate to /app again. No loop.
        await clearAuthCookieFn();
        throw redirect({ to: "/access-denied" });

      case "ok":
        return { userId: session.userId, organizationId: session.organizationId };
    }
  },

  component: AppLayout,
});

function AppLayout() {
  return <Outlet />;
}
