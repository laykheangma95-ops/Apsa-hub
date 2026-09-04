/**
 * Organization creation service (server-only).
 *
 * Never import this module statically from browser-reachable code — the API
 * boundary (src/api/org.ts) pulls it in with a dynamic import inside the
 * server-function handler body, the same pattern used by the customer and
 * product domains.
 *
 * Security design:
 *   - Founder identity comes from the validated session, never from request body.
 *   - Calls the create_organization_for_founder RPC under the user's own JWT.
 *     The RPC uses auth.uid() internally — no privilege escalation via service role.
 *   - Email verification is re-asserted here as defence in depth; the API boundary
 *     enforces it independently before this function is ever reached.
 *   - No availability pre-check: the DB unique constraint organizations_slug_unique
 *     is the only authority, and PostgreSQL 23505 maps to slug_taken.
 *
 * NEVER import supabaseAdmin or SUPABASE_SERVICE_ROLE_KEY at module scope here:
 * createServerClient is imported dynamically inside the function body so
 * @/lib/supabase/server (which also exports supabaseAdmin) stays server-side.
 */
import type { ServerSession } from "@/api/auth";
import type { CreateOrganizationInput, CreateOrganizationResult } from "@/lib/org-schema";

// Re-exported so the contract has one home while callers (and the slug tests)
// can keep importing it from the domain module.
export { slugSchema, CreateOrganizationInputSchema } from "@/lib/org-schema";
export type {
  CreateOrganizationInput,
  CreateOrganizationResult,
  CreateOrganizationSuccess,
} from "@/lib/org-schema";

// ── RPC response shape ────────────────────────────────────────────────────────

interface RpcSuccess {
  status: "success";
  org_id: string;
  slug: string;
}
interface RpcAlreadyMember {
  status: "already_member";
  org_id: string;
}
interface RpcSlugTaken {
  status: "slug_taken";
}
interface RpcInvalidInput {
  status: "invalid_input";
  detail: string;
}

type RpcResult = RpcSuccess | RpcAlreadyMember | RpcSlugTaken | RpcInvalidInput;

// ── createOrganizationForFounder ──────────────────────────────────────────────

export async function createOrganizationForFounder(
  session: ServerSession,
  data: CreateOrganizationInput,
): Promise<CreateOrganizationResult> {
  // Defence in depth — the caller has already enforced this.
  if (!session.emailVerified) return { ok: false, code: "email_not_verified" };

  // Call the RPC under the user's own JWT.
  // The RPC uses auth.uid() — no founder_user_id parameter accepted.
  // Service role is NOT used here — it would bypass the auth.uid() guard.
  // Dynamic import — keeps @/lib/supabase/server out of the client bundle.
  const { createServerClient } = await import("@/lib/supabase/server");
  const userClient = createServerClient(session.accessToken);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rpcResult, error } = await (userClient as any).rpc(
    "create_organization_for_founder",
    {
      p_legal_name: data.legalName,
      p_display_name: data.displayName,
      p_slug: data.slug,
      p_business_type: data.businessType ?? null,
      p_currency: data.currency,
    },
  );

  if (error) {
    // The RPC raises exceptions for unauthenticated (should not reach here after
    // the session check, but guard defensively).
    if (error.message?.includes("unauthenticated")) {
      return { ok: false, code: "unauthenticated" };
    }
    // PostgreSQL 23505 (unique_violation) is the authoritative signal that the
    // identifier is already claimed. The RPC normally catches it and returns a
    // status; if it ever surfaces as a transport error it must still map to the
    // same friendly result — never to internal_error.
    if (error.code === "23505") {
      return { ok: false, code: "slug_taken" };
    }
    return { ok: false, code: "internal_error", message: error.message };
  }

  const result = rpcResult as unknown as RpcResult;

  switch (result.status) {
    case "success":
      return { ok: true, orgId: result.org_id, slug: result.slug };

    case "already_member":
      return { ok: false, code: "already_member", orgId: result.org_id };

    case "slug_taken":
      return { ok: false, code: "slug_taken" };

    case "invalid_input":
      return { ok: false, code: "invalid_input", detail: result.detail };

    default:
      return { ok: false, code: "internal_error", message: "Unexpected RPC response" };
  }
}
