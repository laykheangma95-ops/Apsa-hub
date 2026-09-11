/**
 * Organization domain server functions — TanStack Start API boundary.
 *
 * Security model:
 *   - Session is read from HttpOnly cookies via getSessionFn (never from the body).
 *   - Email verification is enforced here, independently of getSessionFn's own
 *     checks and of anything the UI or the database might do.
 *   - Organizations are created ONLY by the create_organization_for_founder RPC
 *     (migration 009) — never by direct multi-step inserts. The founder's OWNER
 *     membership is created by that same RPC, in the same transaction.
 *   - No organization_id is ever accepted from the caller.
 *   - No slug availability pre-check: the DB unique constraint
 *     organizations_slug_unique is the sole authority.
 *   - The server-only service module (@/server/org/create-organization) is
 *     dynamically imported inside the handler body so it never enters the
 *     client bundle.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSessionFn } from "@/api/auth";
import { CreateOrganizationInputSchema } from "@/lib/org-schema";
import type { CreateOrganizationResult } from "@/lib/org-schema";
import type { AuthorizationContext } from "@/server/auth/authorization";
import type { OrganizationProfile } from "@/server/org/get-organization-profile";

export { slugSchema, CreateOrganizationInputSchema } from "@/lib/org-schema";
export type {
  CreateOrganizationInput,
  CreateOrganizationResult,
  CreateOrganizationSuccess,
} from "@/lib/org-schema";
export type { OrganizationProfile } from "@/server/org/get-organization-profile";

export const createOrganizationFn = createServerFn()
  .validator((data: unknown) => CreateOrganizationInputSchema.parse(data))
  .handler(async ({ data }): Promise<CreateOrganizationResult> => {
    // 1. Validate the session from cookies — never trust client-provided identity.
    const session = await getSessionFn();
    if (!session) return { ok: false, code: "unauthenticated" };

    // 2. Enforce email verification independently (not delegated to UI or DB).
    if (!session.emailVerified) return { ok: false, code: "email_not_verified" };

    // 3. Hand off to the server-only service, which calls the RPC under the
    //    founder's own JWT.
    const { createOrganizationForFounder } = await import("@/server/org/create-organization");

    return createOrganizationForFounder(session, data);
  });

// ── getOrganizationProfileFn — Settings "Business" section ─────────────────────
//
// Read-only. organizationId is NEVER accepted from the caller — always derived
// from the caller's own active DB membership. Identical resolveAuthContext
// pattern to src/api/team.ts / src/api/customers.ts.

async function resolveAuthContext(): Promise<AuthorizationContext> {
  const session = await getSessionFn();
  if (!session || !session.emailVerified) {
    const { UnauthorizedError } = await import("@/server/auth/authorization");
    throw new UnauthorizedError("Not authenticated");
  }

  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { AuthorizationService } = await import("@/server/auth/authorization");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawMembership } = await (supabaseAdmin as any)
    .from("memberships")
    .select("organization_id")
    .eq("user_id", session.userId)
    .eq("status", "active")
    .order("joined_at", { ascending: false })
    .limit(1)
    .single();

  if (!rawMembership) {
    const { ForbiddenError } = await import("@/server/auth/authorization");
    throw new ForbiddenError("No active organization membership");
  }

  const membership = rawMembership as { organization_id: string };
  return AuthorizationService.forRequest(session.userId, membership.organization_id);
}

export const getOrganizationProfileFn = createServerFn().handler(
  async (): Promise<OrganizationProfile> => {
    const authCtx = await resolveAuthContext();
    const { getOrganizationProfile } = await import("@/server/org/get-organization-profile");
    return getOrganizationProfile(authCtx);
  },
);
