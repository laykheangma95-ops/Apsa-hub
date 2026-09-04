/**
 * Server-only organization creation service.
 *
 * NEVER import this file from browser-bundled code or React components.
 * This module uses the service-role key and executes privileged DB operations.
 *
 * Entry point: the Postgres RPC `create_organization_for_founder` defined in
 * migration 009. The entire operation runs in a single DB transaction —
 * org + OWNER membership + workspace + location + audit log — all or nothing.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import { z } from "zod";

// ── Input validation ──────────────────────────────────────────────────────────

export const createOrganizationSchema = z.object({
  legalName: z
    .string()
    .min(2, "Business name must be at least 2 characters")
    .max(200, "Business name must be 200 characters or fewer")
    .trim(),
  slug: z
    .string()
    .min(3, "Short name must be at least 3 characters")
    .max(63, "Short name must be 63 characters or fewer")
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/,
      "Short name may only contain lowercase letters, numbers and hyphens, and must not start or end with a hyphen",
    )
    .toLowerCase(),
  displayName: z.string().max(200).trim().optional(),
  businessType: z.string().max(100).trim().optional(),
  defaultCurrency: z.enum(["USD", "KHR"]).default("USD"),
  timezone: z.string().default("Asia/Phnom_Penh"),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

// ── Result types ──────────────────────────────────────────────────────────────

export type CreateOrgSuccess = {
  ok: true;
  organizationId: string;
};

export type CreateOrgError =
  | { ok: false; code: "slug_taken" }
  | { ok: false; code: "founder_not_found" }
  | { ok: false; code: "already_member"; organizationId: string }
  | { ok: false; code: "internal_error"; message: string };

export type CreateOrgResult = CreateOrgSuccess | CreateOrgError;

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Create an organization for the authenticated founder in a single DB transaction.
 *
 * `founderUserId` MUST come from the server-side validated auth session —
 * never from a client-provided request field.
 */
export async function createOrganizationForFounder(
  founderUserId: string,
  input: CreateOrganizationInput,
): Promise<CreateOrgResult> {
  // Type cast required: hand-authored Database.Functions types are temporary scaffolding
  // (see src/lib/supabase/types.ts). Replace with supabase gen types once migrations are applied.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin.rpc as any)("create_organization_for_founder", {
    p_founder_user_id:  founderUserId,
    p_legal_name:       input.legalName,
    p_slug:             input.slug,
    p_display_name:     input.displayName ?? null,
    p_business_type:    input.businessType ?? null,
    p_default_currency: input.defaultCurrency,
    p_timezone:         input.timezone,
  }) as { data: string | null; error: { message?: string; code?: string } | null };

  if (error) {
    return mapRpcError(error, input.slug);
  }

  return { ok: true, organizationId: data as string };
}

/**
 * Check whether a slug is already taken (best-effort — DB unique constraint is authoritative).
 * Use only for real-time UX feedback; never rely on this for correctness.
 */
export async function isSlugAvailable(slug: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("slug", slug.toLowerCase())
    .maybeSingle();

  if (error) return true; // conservative: assume available on error, let DB decide
  return data === null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Exported for unit tests only — call mapRpcError instead in production code. */
export const mapRpcErrorForTest = (
  error: { message?: string; code?: string },
  slug: string,
): CreateOrgError => mapRpcError(error, slug);

function mapRpcError(error: { message?: string; code?: string }, slug: string): CreateOrgError {
  const msg = error.message ?? "";
  const code = error.code ?? "";

  // Postgres unique violation on slug (23505 = unique_violation)
  if (
    code === "23505" ||
    msg.includes("organizations_slug_unique") ||
    msg.includes("duplicate key")
  ) {
    return { ok: false, code: "slug_taken" };
  }

  // Custom exception from the PL/pgSQL function
  if (msg.includes("founder_not_found")) {
    return { ok: false, code: "founder_not_found" };
  }

  // Duplicate active membership (user already has an org — retry scenario)
  if (msg.includes("idx_memberships_user_org_active")) {
    // Fetch the existing membership's org ID for the idempotent-response path
    return { ok: false, code: "already_member", organizationId: "" };
  }

  return { ok: false, code: "internal_error", message: msg };
}
