/**
 * Parcel label view-model builder (pure, client-safe).
 *
 * Assembles a 100×150 mm shipping label (§13, §15, §18) from the authoritative,
 * already-PII-gated data the fulfillment service returns. It:
 *
 *   - formats the product list concisely ("2 × Classic Tee · Black / M") and
 *     truncates a long order to keep the label readable, reporting how many lines
 *     it hid rather than shrinking the text to nothing (§15);
 *   - presents payment from authoritative fields only — PAID vs an amount to
 *     collect formatted with the shared formatMoney; it NEVER recomputes a COD
 *     amount (§18);
 *   - builds the order QR from the order id (an internal reference, no PII, no
 *     secret — §19) and renders it.
 *
 * It carries no user-facing prose (PAID/COD wording is the component's i18n job).
 * It deliberately has no field for email, notes, analytics or any credential — the
 * input shape simply does not include them (§14).
 */
import type { Money } from "@/types";
import { formatMoney } from "@/lib/money";
import { renderQrSvg } from "@/lib/barcode/qr";
import { orderQrPayload } from "@/lib/barcode/payload";

/** Default physical target for a parcel label. */
export const PARCEL_LABEL_SIZE_MM = { width: 100, height: 150 } as const;

/** How many product lines fit before the label switches to a continuation note. */
export const PARCEL_LABEL_MAX_ITEM_LINES = 8;

export interface ParcelLabelItemInput {
  quantity: number;
  productName: string;
  variantName: string | null;
}

/**
 * Input mirrors the server's ParcelLabelData structurally but is declared here so
 * the client label toolkit does not import a server module. The client API
 * wrapper passes the server response straight in.
 */
export interface ParcelLabelInput {
  merchant: { businessName: string };
  customer: { name: string | null; phone: string | null; address: string | null };
  order: { id: string; orderNumber: string; itemCount: number; items: ParcelLabelItemInput[] };
  payment: { paid: boolean; collect: Money | null };
  delivery: { providerName: string; trackingNumber: string | null; status: string } | null;
}

export interface ParcelLabelLine {
  quantity: number;
  productName: string;
  variantName: string | null;
  /** Concise one-line rendering, e.g. "2 × Classic Tee · Black / M". */
  text: string;
}

export interface ParcelLabelViewModel {
  merchantName: string;
  customer: { name: string | null; phone: string | null; address: string | null };
  orderNumber: string;
  itemCount: number;
  items: ParcelLabelLine[];
  /** Lines beyond the cap that were not shown; 0 when everything fits (§15). */
  overflowCount: number;
  payment: {
    paid: boolean;
    /** Amount to collect, formatted; null when fully paid. */
    collectFormatted: string | null;
  };
  delivery: { providerName: string; trackingNumber: string | null; status: string } | null;
  qr: { payload: string; svg: string };
}

function formatItemLine(item: ParcelLabelItemInput): string {
  const base = `${item.quantity} × ${item.productName}`;
  const variant = item.variantName?.trim();
  return variant ? `${base} · ${variant}` : base;
}

export function buildParcelLabel(
  input: ParcelLabelInput,
  options: { maxItemLines?: number } = {},
): ParcelLabelViewModel {
  const maxLines = options.maxItemLines ?? PARCEL_LABEL_MAX_ITEM_LINES;

  const allLines: ParcelLabelLine[] = input.order.items.map((item) => ({
    quantity: item.quantity,
    productName: item.productName,
    variantName: item.variantName,
    text: formatItemLine(item),
  }));

  const shown = allLines.slice(0, maxLines);
  const overflowCount = Math.max(0, allLines.length - shown.length);

  const payload = orderQrPayload(input.order.id);

  return {
    merchantName: input.merchant.businessName,
    customer: {
      name: input.customer.name,
      phone: input.customer.phone,
      address: input.customer.address,
    },
    orderNumber: input.order.orderNumber,
    itemCount: input.order.itemCount,
    items: shown,
    overflowCount,
    payment: {
      paid: input.payment.paid,
      // Formatted from the authoritative Money value only. When paid, there is
      // nothing to collect — the amount is intentionally null, never printed.
      collectFormatted: input.payment.paid || !input.payment.collect
        ? null
        : formatMoney(input.payment.collect),
    },
    delivery: input.delivery,
    qr: { payload, svg: renderQrSvg(payload, { moduleSize: 4, quietModules: 3, ecLevel: "M" }) },
  };
}
