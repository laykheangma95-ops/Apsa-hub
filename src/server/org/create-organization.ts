/**
 * Atomic organization creation — server-side only.
 *
 * Creates in sequence: organization → OWNER membership → default workspace → default location
 * → audit record. Cleans up all created rows on any step failure.
 *
 * Security invariants:
 * - userId is always derived from the validated JWT (never from the client body)
 * - client cannot choose their role; OWNER is applied automatically for the founder
 * - no partial organization states survive a failure
 *
 * NOTE: True DB-level atomicity would require a Supabase RPC function (PostgreSQL
 * transaction). The sequential-with-cleanup approach here achieves the same practical
 * guarantee for normal failures. Add an RPC migration when DB-level rollback is required.
 */
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";
import { validateSession } from "@/server/auth/session";
import type { Database } from "@/lib/supabase/types";

type OrgInsert = Database["public"]["Tables"]["organizations"]["Insert"];
type MembershipInsert = Database["public"]["Tables"]["memberships"]["Insert"];
type WorkspaceInsert = Database["public"]["Tables"]["workspaces"]["Insert"];
type LocationInsert = Database["public"]["Tables"]["locations"]["Insert"];
type AuditLogInsert = Database["public"]["Tables"]["audit_logs"]["Insert"];

export const createOrgSchema = z.object({
  accessToken: z.string().min(1),
  displayName: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens only"),
  defaultCurrency: z.string().length(3),
  country: z.string().min(2).max(2),
  timezone: z.string().min(1),
});

export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export interface CreateOrgResult {
  organizationId: string;
  slug: string;
}

/**
 * Create an organization with all required supporting entities.
 * Validates the caller's session server-side; never trusts userId from the client.
 */
export async function createOrganization(input: CreateOrgInput): Promise<CreateOrgResult> {
  const data = createOrgSchema.parse(input);

  // 1. Validate session — derive userId from JWT, never from client body
  const authSession = await validateSession(data.accessToken);
  if (!authSession) {
    throw new Error("Unauthorized: invalid or expired session");
  }
  const userId = authSession.userId;

  // 2. Slug uniqueness check
  const { data: existing } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("slug", data.slug)
    .maybeSingle();

  if (existing) {
    throw new Error("slug_taken");
  }

  // 3. Resolve system OWNER role — client cannot supply this
  const { data: rawOwnerRole } = await supabaseAdmin
    .from("roles")
    .select("id")
    .eq("system_role", "OWNER")
    .is("organization_id", null)
    .single();

  if (!rawOwnerRole) {
    throw new Error("System OWNER role not seeded — run migrations before creating organizations");
  }
  const ownerRoleId = (rawOwnerRole as unknown as { id: string }).id;

  // 4. Sequential creation with cleanup on failure
  let orgId: string | null = null;
  let membershipId: string | null = null;
  let workspaceId: string | null = null;

  try {
    // 4a. Organization
    const orgInsert: OrgInsert = {
      display_name: data.displayName,
      legal_name: data.displayName,
      slug: data.slug,
      business_type: null,
      default_currency: data.defaultCurrency,
      country: data.country,
      timezone: data.timezone,
      status: "active",
      created_by: userId,
    };
    const { data: org, error: orgErr } = await supabaseAdmin
      .from("organizations")
      .insert(orgInsert as unknown as never)
      .select("id")
      .single();

    if (orgErr || !org) {
      throw new Error(`Failed to create organization: ${orgErr?.message ?? "unknown"}`);
    }
    orgId = (org as unknown as { id: string }).id;

    // 4b. OWNER membership — role is determined server-side, never from client
    const memberInsert: MembershipInsert = {
      user_id: userId,
      organization_id: orgId,
      role_id: ownerRoleId,
      status: "active",
      invited_by: null,
    };
    const { data: membership, error: memberErr } = await supabaseAdmin
      .from("memberships")
      .insert(memberInsert as unknown as never)
      .select("id")
      .single();

    if (memberErr || !membership) {
      throw new Error(`Failed to create membership: ${memberErr?.message ?? "unknown"}`);
    }
    membershipId = (membership as unknown as { id: string }).id;

    // 4c. Default workspace
    const wsInsert: WorkspaceInsert = {
      organization_id: orgId,
      name: "Main Workspace",
      type: "BUSINESS",
      status: "active",
      settings: {},
    };
    const { data: workspace, error: wsErr } = await supabaseAdmin
      .from("workspaces")
      .insert(wsInsert as unknown as never)
      .select("id")
      .single();

    if (wsErr || !workspace) {
      throw new Error(`Failed to create workspace: ${wsErr?.message ?? "unknown"}`);
    }
    workspaceId = (workspace as unknown as { id: string }).id;

    // 4d. Default location
    const locInsert: LocationInsert = {
      organization_id: orgId,
      workspace_id: workspaceId,
      name: "Main Location",
      type: "branch",
      timezone: data.timezone,
      status: "active",
      phone: null,
    };
    const { error: locErr } = await supabaseAdmin
      .from("locations")
      .insert(locInsert as unknown as never);

    if (locErr) {
      throw new Error(`Failed to create location: ${locErr.message}`);
    }

    // 5. Audit record — best-effort (org.create is not a mandatory-audit action)
    const auditInsert: AuditLogInsert = {
      organization_id: orgId,
      actor_user_id: userId,
      action: "org.create",
      resource_type: "organization",
      resource_id: orgId,
      before_json: null,
      after_json: { display_name: data.displayName, slug: data.slug },
      reason: "Organization created by founding member",
      ip_address: null,
      user_agent: null,
    };
    await supabaseAdmin.from("audit_logs").insert(auditInsert as unknown as never);

    return { organizationId: orgId, slug: data.slug };
  } catch (err) {
    // Best-effort rollback — clean up in reverse creation order
    if (workspaceId) {
      await supabaseAdmin.from("locations").delete().eq("workspace_id", workspaceId);
      await supabaseAdmin.from("workspaces").delete().eq("id", workspaceId);
    }
    if (membershipId) {
      await supabaseAdmin.from("memberships").delete().eq("id", membershipId);
    }
    if (orgId) {
      await supabaseAdmin.from("organizations").delete().eq("id", orgId);
    }
    throw err;
  }
}
