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
let db = supabaseAdmin as any;

/**
 * Test-only override for exercising repository functions against a mocked
 * query chain. Same convention as setOrderRepositoryDbForTests — it is what
 * lets a test prove that a phone query was NEVER ISSUED, rather than only
 * that its result was hidden afterwards.
 */
export function setCustomerRepositoryDbForTests(testDb: unknown): () => void {
  const previousDb = db;
  db = testDb;
  return () => {
    db = previousDb;
  };
}

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

// ── Search reads ──────────────────────────────────────────────────────────────
//
// Both functions below filter IN POSTGRES and are scoped to one organization.
// Neither is ever handed a needle the caller has not been authorized for —
// searchCustomersByName is reached only after customers.read, and
// scanCustomersWithPhone only after customers.read AND
// customers.view_sensitive (src/server/customers/service.ts). The repository
// deliberately holds no permission logic of its own; it holds no way to bypass
// one either, because neither function takes an organization from anywhere but
// its argument.

export interface CustomerNameSearchOptions {
  /** Already normalized and LIKE-escaped by the service. */
  pattern: string;
  limit: number;
  offset: number;
}

/**
 * Customers whose display name contains `pattern`, case-insensitively.
 *
 * Server-side filtering: the ILIKE runs in Postgres and only matching rows
 * cross the wire. There is no index on display_name today, so this is a scan
 * of the tenant's own customer rows within the idx_customers_org_status
 * partition — correct and bounded, and fast at MVP customer counts. If a
 * tenant ever grows past the point where that is acceptable, the fix is a
 * pg_trgm GIN index, NOT client-side filtering (see the migration note in the
 * PR description).
 *
 * Ordering is (display_name, id): deterministic, so offset pagination cannot
 * show a row twice or skip one between pages, and two customers with the same
 * name keep a stable relative order.
 *
 * A literal "%" or "_" a merchant typed reaches here backslash-escaped by the
 * service, which is what Postgres LIKE/ILIKE treats as an escape by default —
 * so "100%" searches for that text instead of matching the whole tenant. One
 * character is NOT escapable: PostgREST expands "*" to "%" in a like/ilike
 * value before Postgres sees it, so a typed asterisk still behaves as a
 * wildcard. That over-matches (more rows than asked for) rather than
 * under-matching, so it can never hide a customer who exists.
 */
export async function searchCustomersByName(
  organizationId: string,
  opts: CustomerNameSearchOptions,
): Promise<CustomerRow[]> {
  const { data, error } = await db
    .from("customers")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .ilike("display_name", opts.pattern)
    .order("display_name", { ascending: true })
    .order("id", { ascending: true })
    .range(opts.offset, opts.offset + opts.limit - 1);

  if (error) throw new Error(`searchCustomersByName: ${(error as { message: string }).message}`);
  return (data ?? []) as CustomerRow[];
}

/**
 * One window of the tenant's customers that have a phone number on file.
 *
 * Why a windowed scan and not a WHERE clause on the phone: APSA stores
 * `primary_phone` exactly as it was typed, so "012345678", "012 345 678" and
 * "012-345-678" are three different strings for one number and no single SQL
 * predicate over the raw column finds all three. Comparing digit sequences
 * requires normalizing the stored value, and normalizing it inside the query
 * (regexp_replace) would make idx_customers_primary_phone unusable anyway. The
 * service therefore reduces both sides to digits itself, over a BOUNDED window
 * of rows, and reports honestly when the bound was reached — the same
 * scan-with-a-truncation-signal shape the Delivery list already uses.
 *
 * `primary_phone IS NOT NULL` is pushed into the query, so the scan reads only
 * rows that can possibly match and uses the partial index that exists for
 * exactly that predicate.
 *
 * Ordering is (created_at DESC, id DESC): deterministic, and newest-first so a
 * truncated scan has looked at the most recently created customers — the ones
 * a merchant is most likely searching for.
 */
export async function scanCustomersWithPhone(
  organizationId: string,
  opts: { offset: number; limit: number },
): Promise<CustomerRow[]> {
  const { data, error } = await db
    .from("customers")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .not("primary_phone", "is", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(opts.offset, opts.offset + opts.limit - 1);

  if (error) throw new Error(`scanCustomersWithPhone: ${(error as { message: string }).message}`);
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
    throw new Error(
      `addCustomerIdentity: ${(error as { message?: string })?.message ?? "no data"}`,
    );
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
  return (data ?? []).map(
    (row: CustomerNoteRow & { profiles: { display_name: string | null } | null }) => ({
      ...row,
      author_display_name: row.profiles?.display_name ?? null,
    }),
  );
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

export async function assignTagToCustomer(customerId: string, tagId: string): Promise<void> {
  const { error } = await db
    .from("customer_tag_assignments")
    .upsert(
      { customer_id: customerId, tag_id: tagId },
      { onConflict: "customer_id,tag_id", ignoreDuplicates: true },
    );

  if (error) throw new Error(`assignTagToCustomer: ${(error as { message: string }).message}`);
}

export async function removeTagFromCustomer(customerId: string, tagId: string): Promise<void> {
  const { error } = await db
    .from("customer_tag_assignments")
    .delete()
    .eq("customer_id", customerId)
    .eq("tag_id", tagId);

  if (error) throw new Error(`removeTagFromCustomer: ${(error as { message: string }).message}`);
}
