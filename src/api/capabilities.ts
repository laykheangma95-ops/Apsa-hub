/**
 * Active-member UI capability snapshot — TanStack Start API boundary.
 *
 * Answers exactly one question, for the caller only: "what may the member
 * behind this session see in the UI of their active organization?"
 *
 * Security model — identical to src/api/org.ts and src/api/team.ts:
 *   - The handler takes NO input. There is no validator and no parameter, so a
 *     crafted request cannot supply a user_id, organization_id, role, or a
 *     permission list. Everything is derived server-side.
 *   - user_id comes only from the validated HttpOnly-cookie session (getSessionFn).
 *   - organization_id comes only from the caller's own active DB membership.
 *   - Permissions come only from the existing resolver
 *     (AuthorizationService → verifyActiveMembership → roles → role_permissions).
 *   - Server-only modules (@/lib/supabase/server, @/server/auth/authorization)
 *     are dynamically imported inside the handler body, so the service-role
 *     client never enters the client bundle.
 *   - The response is filtered down to UI_PERMISSION_KEYS: the browser receives
 *     only the bits this UI consults, never the full internal permission set.
 *
 * This snapshot is a presentation hint. It is never an authorization decision:
 * every read and mutation is authorized again, independently, by the server.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSessionFn } from "@/api/auth";
import { UI_PERMISSION_KEYS } from "@/lib/capabilities";
import type { CapabilityResult, UiPermissionKey } from "@/lib/capabilities";

export type { CapabilityResult, CapabilitySnapshot } from "@/lib/capabilities";

export const getActiveMemberCapabilitiesFn = createServerFn().handler(
  async (): Promise<CapabilityResult> => {
    // 1. Session from cookies. Never a client-supplied identity.
    const session = await getSessionFn();
    if (!session) return { status: "unauthenticated" };

    // 2. Email verification, enforced here as well as in the /app guard.
    if (!session.emailVerified) return { status: "email_unverified" };

    // 3. Active organization from the caller's own membership rows.
    //
    //    joined_at DESC + status='active' deliberately matches the
    //    resolveAuthContext() helper used by every domain API in src/api/*, so
    //    the snapshot describes the same organization those actions will act
    //    on. If it ever diverged, the UI would advertise one organization's
    //    access while the server applied another's.
    const { supabaseAdmin } = await import("@/lib/supabase/server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rawMembership } = await (supabaseAdmin as any)
      .from("memberships")
      .select("organization_id")
      .eq("user_id", session.userId)
      .eq("status", "active")
      .order("joined_at", { ascending: false })
      .limit(1)
      .single();

    if (!rawMembership) return { status: "no_membership" };
    const membership = rawMembership as { organization_id: string };

    // 4. Real permission resolution — the same path every server action uses.
    const { AuthorizationService } = await import("@/server/auth/authorization");

    let permissions: UiPermissionKey[];
    let role: string | null;
    let organizationId: string;
    try {
      const authCtx = await AuthorizationService.forRequest(
        session.userId,
        membership.organization_id,
      );
      permissions = UI_PERMISSION_KEYS.filter((key) => authCtx.can(key));
      role = authCtx.systemRole;
      organizationId = authCtx.organizationId;
    } catch {
      // Membership disappeared or could not be resolved between the two reads:
      // report no membership rather than an empty "active" snapshot, so the UI
      // fails closed instead of rendering a stripped-down but signed-in shell.
      return { status: "no_membership" };
    }

    return {
      status: "active",
      userId: session.userId,
      organizationId,
      role,
      permissions,
    };
  },
);
