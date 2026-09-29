/**
 * The reviewed service_role privilege matrix for the `public` schema at
 * migration 048. It is the single source of truth for two tests:
 *
 *   - service-role-table-grants.test.ts  parses migration 048's GRANT statements
 *     and requires them to equal MIGRATION_048_GRANTS exactly;
 *   - service-role-table-grants.runtime.ts applies every migration to a real
 *     PostgreSQL (PGlite) under Supabase's restricted default privileges and
 *     requires the resulting catalog to equal EXPECTED_SERVICE_ROLE_PRIVILEGES —
 *     for EVERY relation in `public`, so an unlisted object fails the test.
 *
 * Changing a row here is a security decision: it must be argued in review.
 */

export type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

const SIUD: Privilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];

/** Exactly what migration 048 grants to service_role, per object. */
export const MIGRATION_048_GRANTS: Readonly<Record<string, readonly Privilege[]>> = {
  // identity / tenancy / access control
  permissions: ["SELECT"],
  role_permissions: ["SELECT"],
  roles: ["SELECT"],
  profiles: ["SELECT"],
  organizations: ["SELECT", "UPDATE"],
  memberships: ["SELECT", "UPDATE"],
  invitations: ["SELECT", "INSERT", "UPDATE"],
  workspaces: ["SELECT"],
  locations: ["SELECT"],
  // audit
  audit_logs: ["SELECT", "INSERT"],
  // customers
  customers: ["SELECT", "INSERT", "UPDATE"],
  customer_identities: ["SELECT", "INSERT", "DELETE"],
  customer_notes: ["SELECT", "INSERT"],
  customer_tags: ["SELECT", "INSERT"],
  customer_tag_assignments: ["SELECT", "INSERT", "DELETE"],
  customer_addresses: ["SELECT"],
  // catalogue
  product_categories: ["SELECT", "INSERT", "UPDATE"],
  products: ["SELECT", "INSERT", "UPDATE"],
  product_variants: ["SELECT", "INSERT", "UPDATE"],
  // inventory
  inventory_movements: ["SELECT", "INSERT"],
  inventory_stock: ["SELECT"],
  // orders
  orders: ["SELECT"],
  order_items: ["SELECT"],
  order_status_history: ["SELECT"],
  order_number_sequences: ["SELECT"],
  // delivery
  deliveries: ["SELECT"],
  delivery_providers: ["SELECT"],
  delivery_status_history: ["SELECT"],
  // payments — READ ONLY (migration 040)
  payments: ["SELECT"],
  payment_events: ["SELECT"],
  payment_evidence: ["SELECT"],
  payment_reconciliation_summary: ["SELECT"],
};

/** Already explicit in earlier migrations; 048 must neither add to nor remove from these. */
export const EARLIER_EXPLICIT_GRANTS: Readonly<Record<string, readonly Privilege[]>> = {
  // 037
  conversations: SIUD,
  messages: SIUD,
  conversation_read_markers: SIUD,
  conversation_participants: SIUD,
  // 040
  order_payment_totals: ["SELECT"],
  // 045 — webhook_event_receipts is deliberately never UPDATE
  rate_limit_buckets: SIUD,
  webhook_event_receipts: ["SELECT", "INSERT", "DELETE"],
};

/** The full expected service_role privileges (SELECT/INSERT/UPDATE/DELETE) after 001–048. */
export const EXPECTED_SERVICE_ROLE_PRIVILEGES: Readonly<Record<string, readonly Privilege[]>> = {
  ...MIGRATION_048_GRANTS,
  ...EARLIER_EXPLICIT_GRANTS,
};

/** Tables whose direct writes migration 040 removed from service_role. */
export const PAYMENT_LEDGER = ["payments", "payment_events", "payment_evidence"] as const;
