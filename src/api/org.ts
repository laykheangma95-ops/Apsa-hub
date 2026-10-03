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
import {
  CreateOrganizationInputSchema,
  UpdateOrganizationProfileInputSchema,
} from "@/lib/org-schema";
import type { CreateOrganizationResult } from "@/lib/org-schema";
import type { AuthorizationContext } from "@/server/auth/authorization";
import type { OrganizationProfile } from "@/server/org/get-organization-profile";

export {
  slugSchema,
  CreateOrganizationInputSchema,
  UpdateOrganizationProfileInputSchema,
} from "@/lib/org-schema";
export type {
  CreateOrganizationInput,
  CreateOrganizationResult,
  CreateOrganizationSuccess,
  UpdateOrganizationProfileInput,
} from "@/lib/org-schema";
export type { OrganizationProfile } from "@/server/org/get-organization-profile";

export const createOrganizationFn = createServerFn({ method: "POST" })
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

  const { AuthorizationService } = await import("@/server/auth/authorization");

  // organization_id is derived from the canonical active membership
  // (src/lib/active-organization.ts), never client input.
  const { resolveActiveOrganizationId } = await import("@/server/auth/active-organization");
  const organizationId = await resolveActiveOrganizationId(session.userId);

  if (!organizationId) {
    const { ForbiddenError } = await import("@/server/auth/authorization");
    throw new ForbiddenError("No active organization membership");
  }

  return AuthorizationService.forRequest(session.userId, organizationId);
}

export const getOrganizationProfileFn = createServerFn().handler(
  async (): Promise<OrganizationProfile> => {
    const authCtx = await resolveAuthContext();
    const { getOrganizationProfile } = await import("@/server/org/get-organization-profile");
    return getOrganizationProfile(authCtx);
  },
);

// ── updateOrganizationProfileFn — Settings "Business" → Edit (Phase 1) ─────
//
// Same resolveAuthContext() as the read above: organizationId is always the
// caller's own active membership, never accepted from the client. The
// validator's `.strict()` schema rejects any field outside the allowlist
// before the handler body even runs — see UpdateOrganizationProfileInputSchema
// in src/lib/org-schema.ts for exactly which fields those are and why.

export const updateOrganizationProfileFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => UpdateOrganizationProfileInputSchema.parse(data))
  .handler(async ({ data }): Promise<OrganizationProfile> => {
    const authCtx = await resolveAuthContext();
    const { updateOrganizationProfile } = await import("@/server/org/update-organization-profile");
    return updateOrganizationProfile(authCtx, data);
  });
