/**
 * Customer repository — raw DB operations.
 *
 * All functions:
 *   - Accept organizationId from a server-validated auth context (never from the client).
 *   - Filter every query by organization_id so RLS + application code are both layered.
 *   - Use supabaseAdmin (service-role) so writes can bypass RLS where the application
 *     layer has already performed authorization; RLS remains as defense-in-depth.
 *
 * supabaseAdmin is cast to `any` for the new customer tables because the hand-authored
 * types in src/lib/supabase/types.ts predate migrations 011-015. After the migrations
 * are applied to the live project and `supabase gen types typescript` is run, these
 * casts can be removed.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type {
  CustomerRow,
  CustomerIdentityRow,
  CustomerNoteRow,
  CustomerAddressRow,
  CustomerTagRow,
} from "./types";

// Typed alias for new tables not yet in the generated schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any;

// ── Customers ─────────────────────────────────────────────────────────────────

export async function findCustomerById(
  organizationId: string,
  customerId: string,
): Promise<CustomerRow | null> {
  const { data, error } = await db
    .from("customers")
    .select("*")
    .eq("id", customerId)
    .eq("organization_id", organizationId)
    .single();

  if (error || !data) return null;
  return data as CustomerRow;
}

export async function listCustomers(
  organizationId: string,
  opts: { limit?: number; offset?: number; status?: "active" | "archived" } = {},
): Promise<CustomerRow[]> {
  let query = db
    .from("customers")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (opts.status) query = query.eq("status", opts.status);
  if (opts.limit) query = query.limit(opts.limit);
  if (opts.offset) query = query.range(opts.offset, opts.offset + (opts.limit ?? 50) - 1);

  const { data, error } = await query;
  if (error) throw new Error(`listCustomers: ${(error as { message: string }).message}`);
  return (data ?? []) as CustomerRow[];
}

export async function createCustomer(
  organizationId: string,
  input: {
    display_name: string;
    primary_phone?: string | null;
    primary_email?: string | null;
    language?: string | null;
  },
): Promise<CustomerRow> {
  const { data, error } = await db
    .from("customers")
    .insert({ organization_id: organizationId, ...input })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`createCustomer: ${(error as { message?: string })?.message ?? "no data"}`);
  }
  return data as CustomerRow;
}

export async function updateCustomer(
  organizationId: string,
  customerId: string,
  patch: Partial<{
    display_name: string;
    primary_phone: string | null;
    primary_email: string | null;
    language: string | null;
    status: "active" | "archived";
    last_seen_at: string;
  }>,
): Promise<CustomerRow | null> {
  const { data, error } = await db
    .from("customers")
    .update(patch)
    .eq("id", customerId)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (error) throw new Error(`updateCustomer: ${(error as { message: string }).message}`);
  return data ? (data as CustomerRow) : null;
}

// ── Customer Identities ───────────────────────────────────────────────────────

export async function findIdentitiesByCustomer(
  organizationId: string,
  customerId: string,
): Promise<CustomerIdentityRow[]> {
  const { data, error } = await db
    .from("customer_identities")
    .select("*")
    .eq("customer_id", customerId)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`findIdentitiesByCustomer: ${(error as { message: string }).message}`);
  return (data ?? []) as CustomerIdentityRow[];
}

/** Find a customer by provider identity (for identity resolution). */
export async function findCustomerByProviderIdentity(
  organizationId: string,
  provider: string,
  providerUserId: string,
): Promise<{ customer: CustomerRow; identity: CustomerIdentityRow } | null> {
  const { data, error } = await db
    .from("customer_identities")
    .select("*, customers!inner(*)")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .eq("provider_user_id", providerUserId)
    .single();

  if (error || !data) return null;

  const row = data as CustomerIdentityRow & { customers: CustomerRow };
  return { customer: row.customers, identity: row };
}

/** Attach a new provider identity to an existing customer. */
export async function addCustomerIdentity(
  organizationId: string,
  customerId: string,
  input: {
    provider: string;
    provider_user_id: string;
    handle?: string | null;
    display_name?: string | null;
    identity_metadata?: Record<string, unknown> | null;
    confidence?: number;
    verified_at?: string | null;
  },
): Promise<CustomerIdentityRow> {
  const { data, error } = await db
    .from("customer_identities")
    .insert({
      organization_id: organizationId,
      customer_id: customerId,
      ...input,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`addCustomerIdentity: ${(error as { message?: string })?.message ?? "no data"}`);
  }
  return data as CustomerIdentityRow;
}

export async function removeCustomerIdentity(
  organizationId: string,
  identityId: string,
): Promise<void> {
  const { error } = await db
    .from("customer_identities")
    .delete()
    .eq("id", identityId)
    .eq("organization_id", organizationId);

  if (error) throw new Error(`removeCustomerIdentity: ${(error as { message: string }).message}`);
}

// ── Customer Notes ────────────────────────────────────────────────────────────

export async function findNotesByCustomer(
  organizationId: string,
  customerId: string,
): Promise<(CustomerNoteRow & { author_display_name: string | null })[]> {
  const { data, error } = await db
    .from("customer_notes")
    .select("*, profiles(display_name)")
    .eq("customer_id", customerId)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`findNotesByCustomer: ${(error as { message: string }).message}`);
  return (data ?? []).map((row: CustomerNoteRow & { profiles: { display_name: string | null } | null }) => ({
    ...row,
    author_display_name: row.profiles?.display_name ?? null,
  }));
}

export async function createCustomerNote(
  organizationId: string,
  customerId: string,
  authorUserId: string,
  body: string,
): Promise<CustomerNoteRow & { author_display_name: string | null }> {
  const { data, error } = await db
    .from("customer_notes")
    .insert({
      organization_id: organizationId,
      customer_id: customerId,
      author_user_id: authorUserId,
      body: body.trim(),
    })
    .select("*, profiles(display_name)")
    .single();

  if (error || !data) {
    throw new Error(`createCustomerNote: ${(error as { message?: string })?.message ?? "no data"}`);
  }

  const r = data as CustomerNoteRow & { profiles: { display_name: string | null } | null };
  return { ...r, author_display_name: r.profiles?.display_name ?? null };
}

// ── Customer Addresses ────────────────────────────────────────────────────────

export async function findAddressesByCustomer(
  organizationId: string,
  customerId: string,
): Promise<CustomerAddressRow[]> {
  const { data, error } = await db
    .from("customer_addresses")
    .select("*")
    .eq("customer_id", customerId)
    .eq("organization_id", organizationId)
    .order("is_default", { ascending: false });

  if (error) throw new Error(`findAddressesByCustomer: ${(error as { message: string }).message}`);
  return (data ?? []) as CustomerAddressRow[];
}

// ── Customer Tags ─────────────────────────────────────────────────────────────

export async function findTagsByCustomer(
  organizationId: string,
  customerId: string,
): Promise<CustomerTagRow[]> {
  const { data, error } = await db
    .from("customer_tag_assignments")
    .select("customer_tags(*)")
    .eq("customer_id", customerId);

  if (error) throw new Error(`findTagsByCustomer: ${(error as { message: string }).message}`);

  const rows = (data ?? []) as { customer_tags: CustomerTagRow | null }[];
  return rows
    .map((r) => r.customer_tags)
    .filter((t): t is CustomerTagRow => t !== null && t.organization_id === organizationId);
}

export async function ensureOrFindTag(
  organizationId: string,
  name: string,
): Promise<CustomerTagRow> {
  const { data: existing } = await db
    .from("customer_tags")
    .select("*")
    .eq("organization_id", organizationId)
    .ilike("name", name.trim())
    .maybeSingle();

  if (existing) return existing as CustomerTagRow;

  const { data, error } = await db
    .from("customer_tags")
    .insert({ organization_id: organizationId, name: name.trim() })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`ensureOrFindTag: ${(error as { message?: string })?.message ?? "no data"}`);
  }
  return data as CustomerTagRow;
}

export async function assignTagToCustomer(
  customerId: string,
  tagId: string,
): Promise<void> {
  const { error } = await db
    .from("customer_tag_assignments")
    .upsert(
      { customer_id: customerId, tag_id: tagId },
      { onConflict: "customer_id,tag_id", ignoreDuplicates: true },
    );

  if (error) throw new Error(`assignTagToCustomer: ${(error as { message: string }).message}`);
}

export async function removeTagFromCustomer(
  customerId: string,
  tagId: string,
): Promise<void> {
  const { error } = await db
    .from("customer_tag_assignments")
    .delete()
    .eq("customer_id", customerId)
    .eq("tag_id", tagId);

  if (error) throw new Error(`removeTagFromCustomer: ${(error as { message: string }).message}`);
}
