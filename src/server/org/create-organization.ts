/**
 * Organization creation server function.
 *
 * Security design:
 *   - Founder identity comes from the validated session cookie, never from request body.
 *   - Calls the create_organization_for_founder RPC under the user's own JWT.
 *   - The RPC uses auth.uid() internally — no privilege escalation via service role.
 *   - Email verification is enforced independently here (not delegated to RPC or UI).
 *   - No slug pre-check: DB constraint (organizations_slug_unique) is the only authority.
 *   - Slug validation matches DB constraint: min 3 chars, [a-z0-9][a-z0-9-]+[a-z0-9].
 *
 * NEVER import supabaseAdmin or SUPABASE_SERVICE_ROLE_KEY from browser-bundled code.
 * createServerClient is imported dynamically inside the handler body — never at module
 * scope — so @/lib/supabase/server (which also exports supabaseAdmin) never enters
 * the client bundle through this file.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionFn } from "@/api/auth";

// ── Slug validation schema — matches organizations_slug_format DB constraint ──
// DB: CHECK (slug ~ '^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$')
// Minimum length: 3 (first char + at least 1 middle char + last char)
// Maximum length: 63

export const slugSchema = z
  .string()
  .min(3, "Slug must be at least 3 characters")
  .max(63, "Slug must be at most 63 characters")
  .regex(
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
    "Slug must start and end with a letter or number, and contain only lowercase letters, numbers, and hyphens",
  );

// ── Input schema ──────────────────────────────────────────────────────────────

const CreateOrganizationInput = z.object({
  legalName: z.string().min(1).max(255),
  displayName: z.string().min(1).max(255),
  slug: slugSchema,
  businessType: z.string().max(100).optional(),
  currency: z.enum(["USD", "KHR"]).default("USD"),
});

export type CreateOrganizationInput = z.infer<typeof CreateOrganizationInput>;

// ── Result types ──────────────────────────────────────────────────────────────

export interface CreateOrganizationSuccess {
  ok: true;
  orgId: string;
  slug: string;
}

export type CreateOrganizationResult =
  | CreateOrganizationSuccess
  | { ok: false; code: "unauthenticated" }
  | { ok: false; code: "email_not_verified" }
  | { ok: false; code: "already_member"; orgId: string }
  | { ok: false; code: "slug_taken" }
  | { ok: false; code: "invalid_slug" }
  | { ok: false; code: "invalid_input"; detail: string }
  | { ok: false; code: "internal_error"; message: string };

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
interface RpcSlugTaken { status: "slug_taken" }
interface RpcInvalidInput { status: "invalid_input"; detail: string }

type RpcResult = RpcSuccess | RpcAlreadyMember | RpcSlugTaken | RpcInvalidInput;

// ── createOrganizationFn ──────────────────────────────────────────────────────

export const createOrganizationFn = createServerFn()
  .validator((data: unknown) => CreateOrganizationInput.parse(data))
  .handler(async ({ data }): Promise<CreateOrganizationResult> => {
    // 1. Validate session from cookie — never trust client-provided identity.
    const session = await getSessionFn();
    if (!session) return { ok: false, code: "unauthenticated" };

    // 2. Enforce email verification independently (not delegated to UI or DB).
    if (!session.emailVerified) return { ok: false, code: "email_not_verified" };

    // 3. Call the RPC under the user's own JWT.
    //    The RPC uses auth.uid() — no founder_user_id parameter accepted.
    //    Service role is NOT used here — it would bypass the auth.uid() guard.
    //    Dynamic import — keeps @/lib/supabase/server out of the client bundle.
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
      // session check, but guard defensively).
      if (error.message?.includes("unauthenticated")) {
        return { ok: false, code: "unauthenticated" };
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
  });
