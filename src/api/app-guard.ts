/**
 * Server function for the /app route guard.
 *
 * This module exists to keep supabaseAdmin (service-role client) on the server side.
 * Importing supabaseAdmin directly in a route file would pull it into the client bundle.
 * Using createServerFn ensures TanStack Start's code splitting keeps server code server-only.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSessionFn } from "@/api/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
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
      return { ok: false, redirect: "/access-denied" };
    }

    return { ok: true, session, organizationId: membership.organization_id };
  },
);
