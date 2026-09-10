/**
 * Read-time Home queries. This is deliberately not an analytics store: every
 * row comes from the established transactional tables or their live views.
 * The caller supplies organizationId only from AuthorizationContext.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type {
  HomeDeliveryRow,
  HomeOrderRow,
  HomeRows,
  HomeSettlementRow,
  HomeStockRow,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db = supabaseAdmin as any;

export function setHomeRepositoryDbForTests(testDb: unknown): () => void {
  const previous = db;
  db = testDb;
  return () => {
    db = previous;
  };
}

function errorMessage(error: unknown): string {
  return (error as { message?: string })?.message ?? "unknown error";
}

const orderColumns =
  "id, organization_id, total_minor, currency, lifecycle_status, payment_status, refund_status, fulfillment_status, created_at";

async function queryOrders(
  organizationId: string,
  range?: { from: string; until: string },
): Promise<HomeOrderRow[]> {
  let query = db.from("orders").select(orderColumns).eq("organization_id", organizationId);
  if (range) query = query.gte("created_at", range.from).lt("created_at", range.until);
  const { data, error } = await query;
  if (error) throw new Error(`getHome orders: ${errorMessage(error)}`);
  return (data ?? []) as HomeOrderRow[];
}

export async function getHomeRows(
  organizationId: string,
  range: { from: string; until: string },
  options: { includeFinancials: boolean; includeInventory: boolean; includeDelivery: boolean },
): Promise<HomeRows> {
  const [periodOrders, activeOrders, stockResult, deliveryResult] = await Promise.all([
    queryOrders(organizationId, range),
    queryOrders(organizationId),
    options.includeInventory
      ? db
          .from("inventory_stock")
          .select("organization_id, product_id, variant_id, quantity_on_hand")
          .eq("organization_id", organizationId)
      : Promise.resolve({ data: [], error: null }),
    options.includeDelivery
      ? db
          .from("deliveries")
          .select("id, organization_id, order_id, status")
          .eq("organization_id", organizationId)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (stockResult.error) throw new Error(`getHome inventory: ${errorMessage(stockResult.error)}`);
  if (deliveryResult.error)
    throw new Error(`getHome deliveries: ${errorMessage(deliveryResult.error)}`);

  let settlements: HomeSettlementRow[] = [];
  if (options.includeFinancials && periodOrders.length > 0) {
    const { data, error } = await db
      .from("order_payment_totals")
      .select("order_id, organization_id, currency, net_minor")
      .eq("organization_id", organizationId)
      .in(
        "order_id",
        periodOrders.map((order) => order.id),
      );
    if (error) throw new Error(`getHome settlements: ${errorMessage(error)}`);
    settlements = (data ?? []) as HomeSettlementRow[];
  }

  return {
    periodOrders,
    activeOrders,
    settlements,
    stock: (stockResult.data ?? []) as HomeStockRow[],
    deliveries: (deliveryResult.data ?? []) as HomeDeliveryRow[],
  };
}
