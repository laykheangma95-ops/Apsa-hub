/**
 * Order repository — raw DB operations.
 *
 * All functions:
 *   - Accept organizationId from a server-validated auth context (never from the client).
 *   - Filter every query by organization_id, so the application layer and RLS
 *     both scope the tenant rather than either one being the single point of failure.
 *   - Use supabaseAdmin (service-role). RLS blocks JWT clients from writing to
 *     orders/order_items/order_status_history entirely (migration 023), so the
 *     server domain is the only write path in existence.
 *
 * WRITES GO THROUGH RPCs, NOT TABLE INSERTS
 *   createOrder and transitionStatus call the migration-024 functions rather
 *   than inserting rows. Creating an order writes two tables plus a number
 *   allocation; transitioning writes two tables. supabase-js has no client-side
 *   transaction, so composing those as separate calls would make a partial
 *   order reachable on any failure between them. The RPC is the transaction.
 *
 *   There is deliberately NO generic update function here. If one existed,
 *   some future caller would use it to set a status directly and step around
 *   the state machine, the permission check and the history record.
 *
 * `supabaseAdmin as any` is used because orders / order_items /
 * order_status_history are not yet in the generated Supabase types (migrations
 * 023–025 not yet applied to the live project). After
 * `supabase gen types typescript` is run, remove the cast.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type {
  OrderRow,
  OrderItemRow,
  OrderStatusHistoryRow,
  CreateOrderInput,
  CreateOrderRpcResult,
  TransitionRpcResult,
  ListOrdersOptions,
  OrderStatusAxis,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db = supabaseAdmin as any;

/** Test-only override for exercising repository functions against a mocked query chain. */
export function setOrderRepositoryDbForTests(testDb: unknown): () => void {
  const previousDb = db;
  db = testDb;
  return () => {
    db = previousDb;
  };
}

/** PostgREST "The result contains 0 rows" — returned by .single() on a genuine no-row. */
const PGRST_NO_ROW = "PGRST116";

function errMessage(error: unknown): string {
  return (error as { message?: string })?.message ?? "unknown error";
}

// ── Writes (RPC only) ─────────────────────────────────────────────────────────

/**
 * Create an order and all of its lines in ONE database transaction.
 *
 * organizationId and createdBy are server-supplied. Note that no monetary value
 * is passed except `discount_minor`, which is an input to the calculation and
 * is bounded by the RPC (0 ≤ discount ≤ subtotal) — never a total.
 */
export async function createOrder(
  organizationId: string,
  createdBy: string | null,
  input: CreateOrderInput,
): Promise<CreateOrderRpcResult> {
  const { data, error } = await db.rpc("create_order_v1", {
    p_organization_id: organizationId,
    p_created_by: createdBy,
    p_source: input.source,
    p_items: input.items.map((line) => ({
      variant_id: line.variant_id,
      quantity: line.quantity,
      ...(line.product_id ? { product_id: line.product_id } : {}),
    })),
    p_customer_id: input.customer_id ?? null,
    p_location_id: input.location_id ?? null,
    p_discount_minor: input.discount_minor ?? 0,
  });

  if (error) throw new Error(`createOrder: ${errMessage(error)}`);
  return data as CreateOrderRpcResult;
}

/**
 * Apply one status transition and append its history row in ONE transaction.
 *
 * `expectedFrom` gives the RPC optimistic concurrency: the update applies only
 * if the stored status is still the one the caller validated against, so two
 * concurrent transitions from the same starting state cannot both win.
 */
export async function transitionStatus(
  organizationId: string,
  orderId: string,
  axis: OrderStatusAxis,
  expectedFrom: string,
  to: string,
  changedBy: string | null,
  reason: string | null,
): Promise<TransitionRpcResult> {
  const { data, error } = await db.rpc("transition_order_status_v1", {
    p_organization_id: organizationId,
    p_order_id: orderId,
    p_axis: axis,
    p_expected_from: expectedFrom,
    p_to: to,
    p_changed_by: changedBy,
    p_reason: reason,
  });

  if (error) throw new Error(`transitionStatus: ${errMessage(error)}`);
  return data as TransitionRpcResult;
}

// ── Reads (all org-scoped) ────────────────────────────────────────────────────

/**
 * Returns null both for an order that does not exist and for one belonging to
 * another organization. The caller cannot tell those apart, which is the point:
 * a guessed UUID must not confirm that it named something real.
 */
export async function findOrderById(
  organizationId: string,
  orderId: string,
): Promise<OrderRow | null> {
  const { data, error } = await db
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findOrderById: ${errMessage(error)}`);
  }
  return (data ?? null) as OrderRow | null;
}

export async function listOrders(
  organizationId: string,
  opts: ListOrdersOptions = {},
): Promise<OrderRow[]> {
  let query = db
    .from("orders")
    .select("*")
    .eq("organization_id", organizationId)
    // Secondary sort on id keeps pagination stable when two orders share a
    // created_at — without it, a row can appear on two pages or on neither.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (opts.customer_id) query = query.eq("customer_id", opts.customer_id);
  if (opts.lifecycle_status) query = query.eq("lifecycle_status", opts.lifecycle_status);
  if (opts.payment_status) query = query.eq("payment_status", opts.payment_status);
  if (opts.fulfillment_status) query = query.eq("fulfillment_status", opts.fulfillment_status);
  if (opts.limit) query = query.limit(opts.limit);
  if (opts.offset && opts.limit) {
    query = query.range(opts.offset, opts.offset + opts.limit - 1);
  }

  const { data, error } = await query;
  if (error) throw new Error(`listOrders: ${errMessage(error)}`);
  return (data ?? []) as OrderRow[];
}

export async function listOrderItems(
  organizationId: string,
  orderId: string,
): Promise<OrderItemRow[]> {
  const { data, error } = await db
    .from("order_items")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`listOrderItems: ${errMessage(error)}`);
  return (data ?? []) as OrderItemRow[];
}

export async function listStatusHistory(
  organizationId: string,
  orderId: string,
): Promise<OrderStatusHistoryRow[]> {
  const { data, error } = await db
    .from("order_status_history")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .order("changed_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`listStatusHistory: ${errMessage(error)}`);
  return (data ?? []) as OrderStatusHistoryRow[];
}

// ── Cross-domain ownership checks (read-only, org-scoped) ─────────────────────
// Minimal local lookups rather than importing the Customer/Product repositories,
// so the Order domain does not take a hard module dependency on their internals.
// Same approach as the Inventory repository.

export async function findCustomerForOrg(
  organizationId: string,
  customerId: string,
): Promise<{ id: string; organization_id: string } | null> {
  const { data, error } = await db
    .from("customers")
    .select("id, organization_id")
    .eq("id", customerId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findCustomerForOrg: ${errMessage(error)}`);
  }
  return data ?? null;
}

export async function findVariantForOrg(
  organizationId: string,
  variantId: string,
): Promise<{
  id: string;
  product_id: string;
  organization_id: string;
  status: string;
  price_currency: string;
} | null> {
  const { data, error } = await db
    .from("product_variants")
    .select("id, product_id, organization_id, status, price_currency")
    .eq("id", variantId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findVariantForOrg: ${errMessage(error)}`);
  }
  return data ?? null;
}

export async function findLocationForOrg(
  organizationId: string,
  locationId: string,
): Promise<{ id: string; organization_id: string } | null> {
  const { data, error } = await db
    .from("locations")
    .select("id, organization_id")
    .eq("id", locationId)
    .eq("organization_id", organizationId)
    .single();

  if (error) {
    if ((error as { code?: string }).code === PGRST_NO_ROW) return null;
    throw new Error(`findLocationForOrg: ${errMessage(error)}`);
  }
  return data ?? null;
}
