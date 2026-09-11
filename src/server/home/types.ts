import type { Currency } from "@/types";

export type HomeRange = "today" | "week" | "month";

export interface HomeOrderIdRow {
  id: string;
  created_at: string;
}

export interface HomeSettlementRow {
  order_id: string;
  organization_id: string;
  currency: Currency;
  net_minor: number;
}

export interface HomeStockRow {
  organization_id: string;
  product_id: string;
  variant_id: string;
  location_id: string | null;
  quantity_on_hand: number;
}

export interface HomeActiveVariantRow {
  id: string;
  product_id: string;
}
