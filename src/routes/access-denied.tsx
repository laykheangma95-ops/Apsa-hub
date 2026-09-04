/**
 * Access denied / revoked membership page — /access-denied
 *
 * Shown when a user's membership has been suspended or removed.
 *
 * The auth cookie is cleared BEFORE redirecting here (see app.tsx beforeLoad),
 * so this page has no session. There is no redirect loop:
 *
 *   Revoked user visits /app
 *     → app.tsx beforeLoad detects revoked status
 *     → calls clearAuthCookieFn (cookie gone)
 *     → throws redirect({ to: '/access-denied' })
 *   /access-denied renders with no session (safe, public)
 *   User clicks "Sign in" → /sign-in
 *   If they sign in again:
 *     → setAuthCookieFn sets new cookie
 *     → getSessionFn reads new session → still revoked → /access-denied again
 *   This is correct behavior, not a loop — cookie is cleared each time.
 */

import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/access-denied")({
  head: () => ({
    meta: [{ title: "Access removed — APSA" }],
  }),
  component: AccessDeniedPage,
});

function AccessDeniedPage() {
  async function handleSignOut() {
    try {
      const { supabase } = await import("@/lib/supabase/client");
      const { clearAuthCookieFn } = await import("@/api/auth");
      await Promise.all([supabase.auth.signOut(), clearAuthCookieFn()]);
    } finally {
      window.location.href = "/sign-in";
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-foreground">Access removed</h1>
          <p className="text-sm text-muted-foreground">
            Your access to this organization has been suspended or removed. Contact the
            organization owner if you believe this is a mistake.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Button onClick={handleSignOut} variant="default" className="w-full">
            Sign out
          </Button>
          <Button variant="outline" className="w-full" asChild>
            <a href="/">Go to homepage</a>
          </Button>
        </div>
      </div>
    </div>
  );
}
