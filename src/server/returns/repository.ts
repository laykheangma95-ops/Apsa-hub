/**
 * Customer Returns repository — org-scoped reads and the four write RPCs,
 * through service_role.
 *
 * Same pattern as src/server/inventory/repository.ts: minimal, org-filtered
 * queries via supabaseAdmin. Every write is one of migration 056's RPCs, which
 * re-validate everything themselves under row locks. Never import from
 * browser-bundled code.
 *
 * Row limits: PostgREST answers at most PAGE_SIZE rows per request (its
 * max-rows), silently. Every multi-row read here therefore pages with a
 * deterministic order (ending in the primary key) until a short page proves
 * the end, and splits long `in (...)` lists into chunks. Nothing is summed or
 * shown from a page that might be partial; a read that would need more than
 * MAX_PAGES pages fails loudly instead of returning a truncated answer.
 */
import { supabaseAdmin } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db = supabaseAdmin as any;

export function setReturnsRepositoryDbForTests(testDb: unknown): () => void {
  const previousDb = db;
  db = testDb;
  return () => {
    db = previousDb;
  };
}

function errMessage(error: unknown): string {
  return (error as { message?: string })?.message ?? "unknown error";
}

// ── Complete reads ───────────────────────────────────────────────────────────

/** A PostgREST query that can still be given a row range. */
interface RangeableQuery {
  range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }>;
}

/** PostgREST's per-response row cap (max-rows). A full page may not be the end. */
export const PAGE_SIZE = 1000;
/** Upper bound on pages for one read; beyond it the read fails, never truncates. */
export const MAX_PAGES = 100;
/** Ids per `in (...)` filter, keeping request URLs well inside proxy limits. */
export const IN_CHUNK_SIZE = 100;

/**
 * Every row of a query, page by page. `build` must return a FRESH query with a
 * deterministic order ending in a unique column each time it is called.
 */
async function readAll<T>(label: string, build: () => RangeableQuery): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label}: ${errMessage(error)}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new Error(`${label}: more than ${PAGE_SIZE * MAX_PAGES} rows; refusing a partial read`);
}

/** readAll over `ids` split into chunks (de-duplicated). */
async function readAllIn<T>(
  label: string,
  ids: readonly string[],
  build: (chunk: string[]) => RangeableQuery,
): Promise<T[]> {
  const unique = [...new Set(ids)];
  const rows: T[] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + IN_CHUNK_SIZE);
    rows.push(...(await readAll<T>(label, () => build(chunk))));
  }
  return rows;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export type ReturnStatusDb = "requested" | "received" | "inspected" | "completed";

export interface CustomerReturnRow {
  id: string;
  organization_id: string;
  request_key: string;
  order_id: string;
  delivery_id: string;
  status: ReturnStatusDb;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CustomerReturnItemRow {
  id: string;
  organization_id: string;
  return_id: string;
  order_item_id: string;
  product_id: string;
  variant_id: string;
  product_name_snapshot: string;
  variant_name_snapshot: string | null;
  sku_snapshot: string | null;
  quantity: number;
  damaged_quantity: number | null;
  return_movement_id: string | null;
  damage_movement_id: string | null;
  created_at: string;
}

export interface CustomerReturnEventRow {
  id: string;
  return_id: string;
  from_status: ReturnStatusDb | null;
  to_status: ReturnStatusDb;
  created_at: string;
}

export interface ReturnOrderRow {
  id: string;
  order_number: string;
  lifecycle_status: string;
}

export interface ReturnOrderItemRow {
  id: string;
  order_id: string;
  product_name_snapshot: string;
  variant_name_snapshot: string | null;
  sku_snapshot: string | null;
  quantity: number;
  created_at: string;
}

// ── Returns ──────────────────────────────────────────────────────────────────

/**
 * The newest `limit` returns, and whether more exist. One extra row is read so
 * a full list is reported as partial instead of passing for everything.
 */
export async function listReturns(
  organizationId: string,
  limit: number,
): Promise<{ rows: CustomerReturnRow[]; truncated: boolean }> {
  const { data, error } = await db
    .from("customer_returns")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw new Error(`listReturns: ${errMessage(error)}`);
  const rows = (data ?? []) as CustomerReturnRow[];
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

export async function findReturn(
  organizationId: string,
  returnId: string,
): Promise<CustomerReturnRow | null> {
  const { data, error } = await db
    .from("customer_returns")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", returnId)
    .maybeSingle();
  if (error) throw new Error(`findReturn: ${errMessage(error)}`);
  return (data ?? null) as CustomerReturnRow | null;
}

export async function listReturnItems(
  organizationId: string,
  returnIds: readonly string[],
): Promise<CustomerReturnItemRow[]> {
  return readAllIn<CustomerReturnItemRow>("listReturnItems", returnIds, (chunk) =>
    db
      .from("customer_return_items")
      .select("*")
      .eq("organization_id", organizationId)
      .in("return_id", chunk)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  );
}

/** The complete history of one return, oldest first. */
export async function listReturnEvents(
  organizationId: string,
  returnId: string,
): Promise<CustomerReturnEventRow[]> {
  return readAll<CustomerReturnEventRow>("listReturnEvents", () =>
    db
      .from("customer_return_events")
      .select("id, return_id, from_status, to_status, created_at")
      .eq("organization_id", organizationId)
      .eq("return_id", returnId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  );
}

/** Everything already requested for these order lines, across all returns. */
export async function listRequestedQuantities(
  organizationId: string,
  orderItemIds: readonly string[],
): Promise<Array<{ order_item_id: string; quantity: number }>> {
  return readAllIn<{ id: string; order_item_id: string; quantity: number }>(
    "listRequestedQuantities",
    orderItemIds,
    (chunk) =>
      db
        .from("customer_return_items")
        .select("id, order_item_id, quantity")
        .eq("organization_id", organizationId)
        .in("order_item_id", chunk)
        .order("id", { ascending: true }),
  );
}

// ── Orders (identity and lines only — no money, no customer) ────────────────

export async function listOrderRefs(
  organizationId: string,
  orderIds: readonly string[],
): Promise<ReturnOrderRow[]> {
  return readAllIn<ReturnOrderRow>("listOrderRefs", orderIds, (chunk) =>
    db
      .from("orders")
      .select("id, order_number, lifecycle_status")
      .eq("organization_id", organizationId)
      .in("id", chunk)
      .order("id", { ascending: true }),
  );
}

export async function findOrderByNumber(
  organizationId: string,
  orderNumber: string,
): Promise<ReturnOrderRow | null> {
  const { data, error } = await db
    .from("orders")
    .select("id, order_number, lifecycle_status")
    .eq("organization_id", organizationId)
    .eq("order_number", orderNumber)
    .maybeSingle();
  if (error) throw new Error(`findOrderByNumber: ${errMessage(error)}`);
  return (data ?? null) as ReturnOrderRow | null;
}

export async function listOrderItems(
  organizationId: string,
  orderId: string,
): Promise<ReturnOrderItemRow[]> {
  return readAll<ReturnOrderItemRow>("listOrderItems", () =>
    db
      .from("order_items")
      .select(
        "id, order_id, product_name_snapshot, variant_name_snapshot, sku_snapshot, quantity, created_at",
      )
      .eq("organization_id", organizationId)
      .eq("order_id", orderId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  );
}

export async function hasDeliveredDelivery(
  organizationId: string,
  orderId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("deliveries")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .eq("status", "delivered")
    .limit(1);
  if (error) throw new Error(`hasDeliveredDelivery: ${errMessage(error)}`);
  return ((data ?? []) as unknown[]).length > 0;
}

/** Which of these order lines had stock taken by a sale (migration 026). */
export async function listSoldOrderItemIds(
  organizationId: string,
  orderItemIds: readonly string[],
): Promise<string[]> {
  const rows = await readAllIn<{ id: string; reference_id: string }>(
    "listSoldOrderItemIds",
    orderItemIds,
    (chunk) =>
      db
        .from("inventory_movements")
        .select("id, reference_id")
        .eq("organization_id", organizationId)
        .eq("movement_type", "sale")
        .eq("reference_type", "order_item")
        .in("reference_id", chunk)
        .order("id", { ascending: true }),
  );
  return rows.map((row) => row.reference_id);
}

// ── Write RPCs (migration 056) ───────────────────────────────────────────────

export type RequestReturnRpcResult =
  | { status: "requested" | "replayed"; return_id: string }
  | { status: "request_conflict" }
  | { status: "invalid_items" }
  | { status: "order_not_found" }
  | { status: "order_not_returnable"; lifecycle?: string }
  | { status: "order_not_delivered" }
  | { status: "item_not_in_order"; order_item_id: string }
  | { status: "item_not_returnable"; order_item_id: string }
  | { status: "quantity_exceeds_remaining"; order_item_id: string; remaining: number };

export async function requestReturn(
  organizationId: string,
  actor: string,
  input: {
    request_key: string;
    order_id: string;
    items: Array<{ order_item_id: string; quantity: number }>;
  },
): Promise<RequestReturnRpcResult> {
  const { data, error } = await db.rpc("request_customer_return_v1", {
    p_organization_id: organizationId,
    p_actor: actor,
    p_request_key: input.request_key,
    p_order_id: input.order_id,
    p_items: input.items,
  });
  if (error) throw new Error(`requestReturn: ${errMessage(error)}`);
  return data as RequestReturnRpcResult;
}

export type ReturnStepRpcResult =
  | {
      status: "received" | "inspected" | "completed" | "replayed";
      return_id: string;
      return_status: ReturnStatusDb;
    }
  | { status: "return_not_found" }
  | { status: "not_received"; return_status: ReturnStatusDb }
  | { status: "not_inspected"; return_status: ReturnStatusDb }
  | { status: "already_completed"; return_status: ReturnStatusDb }
  | { status: "stale"; return_status: ReturnStatusDb }
  | { status: "invalid_lines" }
  | { status: "order_not_returnable"; lifecycle?: string };

export async function receiveReturn(
  organizationId: string,
  actor: string,
  returnId: string,
): Promise<ReturnStepRpcResult> {
  const { data, error } = await db.rpc("receive_customer_return_v1", {
    p_organization_id: organizationId,
    p_actor: actor,
    p_return_id: returnId,
  });
  if (error) throw new Error(`receiveReturn: ${errMessage(error)}`);
  return data as ReturnStepRpcResult;
}

type InspectionLinesDb = Array<{ return_item_id: string; damaged_quantity: number }>;

export async function inspectReturn(
  organizationId: string,
  actor: string,
  returnId: string,
  lines: InspectionLinesDb,
): Promise<ReturnStepRpcResult> {
  const { data, error } = await db.rpc("inspect_customer_return_v1", {
    p_organization_id: organizationId,
    p_actor: actor,
    p_return_id: returnId,
    p_lines: lines,
  });
  if (error) throw new Error(`inspectReturn: ${errMessage(error)}`);
  return data as ReturnStepRpcResult;
}

export async function completeReturn(
  organizationId: string,
  actor: string,
  returnId: string,
  expected: InspectionLinesDb,
): Promise<ReturnStepRpcResult> {
  const { data, error } = await db.rpc("complete_customer_return_v1", {
    p_organization_id: organizationId,
    p_actor: actor,
    p_return_id: returnId,
    p_expected: expected,
  });
  if (error) throw new Error(`completeReturn: ${errMessage(error)}`);
  return data as ReturnStepRpcResult;
}
