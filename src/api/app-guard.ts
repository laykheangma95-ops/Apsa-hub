/**
 * Server function for the /app route guard.
 *
 * supabaseAdmin (service-role client) is imported dynamically inside the handler
 * body — never at module scope — so it never enters the client bundle regardless
 * of how the bundler handles TanStack Start's createServerFn code splitting.
 *
 * This file itself is safe to statically import from routes: it only imports
 * createServerFn (public) and getSessionFn (another safe server function).
 */
import { createServerFn } from "@tanstack/react-start";
import { clearAuthCookieFn, getSessionFn } from "@/api/auth";
import type { ServerSession } from "@/api/auth";

export type AppGuardResult =
  | { ok: true; session: ServerSession; organizationId: string }
  | { ok: false; redirect: "/sign-in" | "/verify-email" | "/onboarding" | "/access-denied" };

export const checkAppGuardFn = createServerFn().handler(
  async (): Promise<AppGuardResult> => {
    // 1. Validate session from HttpOnly cookies.
    const session = await getSessionFn();
    if (!session) return { ok: false, redirect: "/sign-in" };

    // 2. Enforce email verification.
    if (!session.emailVerified) return { ok: false, redirect: "/verify-email" };

    // 3. Resolve memberships server-side with the service-role client kept behind
    //    a dynamic import so it never enters the browser bundle.
    const { supabaseAdmin } = await import("@/lib/supabase/server");

    const { data: membershipRows, error } = await supabaseAdmin
      .from("memberships")
      .select("organization_id, status, created_at")
      .eq("user_id", session.userId)
      .in("status", ["active", "suspended", "removed"])
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(error.message);
    }

    const memberships = (membershipRows ?? []) as Array<{
      organization_id: string;
      status: string;
    }>;

    const activeMembership = memberships.find((membership) => membership.status === "active");
    if (activeMembership) {
      return { ok: true, session, organizationId: activeMembership.organization_id };
    }

    const revokedMembership = memberships.find(
      (membership) => membership.status === "suspended" || membership.status === "removed",
    );

    if (revokedMembership) {
      await clearAuthCookieFn();
      return { ok: false, redirect: "/access-denied" };
    }

    return { ok: false, redirect: "/onboarding" };
  },
);
