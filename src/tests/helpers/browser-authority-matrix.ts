/**
 * The reviewed browser-authority boundary after migration 061. Single source of
 * truth for:
 *
 *   - browser-table-authority.test.ts     parses 061's REVOKE statements and
 *     requires them to cover EXACTLY APSA_PUBLIC_RELATIONS;
 *   - browser-table-authority.runtime.ts  applies every migration to a real
 *     PostgreSQL (PGlite) and requires the catalog's relations in `public` to
 *     equal APSA_PUBLIC_RELATIONS (so a relation a later migration adds, and
 *     this list omits, fails the test) and the function EXECUTE matrix to equal
 *     the allowlists below.
 *
 * Changing anything here is a security decision: it must be argued in review.
 */

/** Every relation migrations 001–060 create in `public` (41 tables, 3 views). */
export const APSA_PUBLIC_RELATIONS = [
  // identity, tenancy, access control
  "profiles",
  "organizations",
  "workspaces",
  "locations",
  "roles",
  "permissions",
  "role_permissions",
  "memberships",
  "invitations",
  "audit_logs",
  // customers
  "customers",
  "customer_identities",
  "customer_addresses",
  "customer_notes",
  "customer_tags",
  "customer_tag_assignments",
  // returns
  "customer_returns",
  "customer_return_items",
  "customer_return_events",
  // catalogue
  "product_categories",
  "products",
  "product_variants",
  // inventory
  "inventory_movements",
  "stock_counts",
  "inventory_stock",
  // orders
  "orders",
  "order_items",
  "order_status_history",
  "order_number_sequences",
  // delivery, parcels
  "delivery_providers",
  "deliveries",
  "delivery_status_history",
  "parcels",
  // payments
  "payments",
  "payment_events",
  "payment_evidence",
  "payment_reconciliation_summary",
  "order_payment_totals",
  // conversations
  "conversations",
  "messages",
  "conversation_participants",
  "conversation_read_markers",
  // platform operability
  "rate_limit_buckets",
  "webhook_event_receipts",
] as const;

export const APSA_PUBLIC_VIEWS = [
  "inventory_stock",
  "payment_reconciliation_summary",
  "order_payment_totals",
] as const;

/** The roles a browser request can act as, directly or through PUBLIC. */
export const BROWSER_GRANTEES = ["PUBLIC", "anon", "authenticated"] as const;

/**
 * Non-trigger functions a user JWT (`authenticated`) may EXECUTE. Both are
 * SECURITY DEFINER and derive the caller from auth.uid() themselves.
 */
export const AUTHENTICATED_RPCS = [
  "accept_invitation(text)",
  "create_organization_for_founder(text,text,text,text,text)",
] as const;

/**
 * RLS helper functions referenced by policies. They keep PUBLIC EXECUTE so
 * policy evaluation can never fail with a privilege error; each answers only
 * about the caller's own auth.uid() and returns a boolean.
 */
export const RLS_HELPER_FUNCTIONS = [
  "has_audit_access(uuid)",
  "is_active_member_of(uuid)",
] as const;

/** Exactly what `anon` may EXECUTE among non-trigger functions in `public`. */
export const ANON_EXECUTABLE = [...RLS_HELPER_FUNCTIONS].sort();

/** Exactly what `authenticated` may EXECUTE among non-trigger functions in `public`. */
export const AUTHENTICATED_EXECUTABLE = [...RLS_HELPER_FUNCTIONS, ...AUTHENTICATED_RPCS].sort();
