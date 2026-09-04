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

    // 3. Resolve first membership for this user.
    //    Dynamic import — keeps supabaseAdmin (service-role) out of the client bundle.
    const { supabaseAdmin } = await import("@/lib/supabase/server");

    const { data: rawMembership } = await supabaseAdmin
      .from("memberships")
      .select("organization_id, status")
      .eq("user_id", session.userId)
      .in("status", ["active", "suspended", "removed"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!rawMembership) return { ok: false, redirect: "/onboarding" };

    const membership = rawMembership as unknown as { organization_id: string; status: string };

    if (membership.status === "suspended" || membership.status === "removed") {
      await clearAuthCookieFn();
      return { ok: false, redirect: "/access-denied" };
    }

    return { ok: true, session, organizationId: membership.organization_id };
  },
);
