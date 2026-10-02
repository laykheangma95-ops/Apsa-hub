/**
 * Parcel label view-model builder (pure, client-safe).
 *
 * Assembles a 100×150 mm shipping label (§13, §15, §18) from the authoritative,
 * already-PII-gated data the fulfillment service returns. It:
 *
 *   - formats the product list concisely ("2 × Iced Coffee — Large") and fits it
 *     to a fixed row budget, reporting how many lines it hid rather than
 *     shrinking or clipping text (§15);
 *   - presents payment exactly as the server decided it — PAID, COD with the
 *     server's amount, or CHECK PAYMENT — formatted with the shared formatMoney.
 *     It NEVER recomputes an amount and never prints one unless the state is
 *     COD (§18);
 *   - renders BOTH a QR and a Code 128 barcode of the SAME canonical parcel
 *     identity (APSA:PCL:v1:<token>). Without a parcel code there are no codes
 *     at all (the dialog assigns one before printing) — the label never falls
 *     back to printing an order UUID.
 *
 * It carries no user-facing prose (wording is the component's i18n job). It
 * deliberately has no field for email, notes, analytics or any credential — the
 * input shape simply does not include them (§14).
 */
import type { Money } from "@/types";
import { formatMoney } from "@/lib/money";
import { renderQrSvg } from "@/lib/barcode/qr";
import { renderCode128Svg, isCode128Encodable } from "@/lib/barcode/code128";
import { isValidParcelCode } from "@/lib/barcode/parcel-code";

/** Default physical target for a parcel label. */
export const PARCEL_LABEL_SIZE_MM = { width: 100, height: 150 } as const;

/** Hard cap on product lines, independent of the row budget. */
export const PARCEL_LABEL_MAX_ITEM_LINES = 8;

/**
 * Printed rows available to the product list. A line longer than
 * ITEM_CHARS_PER_ROW wraps to a second row (and is clamped there), so the
 * budget is spent in rows, not lines. A long address takes space from the list.
 */
export const PARCEL_LABEL_ITEM_ROWS = 8;
export const PARCEL_LABEL_ITEM_ROWS_COMPACT = 5;
const ITEM_CHARS_PER_ROW = 44;

/** Above this many characters the address prints in the compact size. */
export const PARCEL_LABEL_LONG_ADDRESS_CHARS = 140;

/** Phnom Penh time — the label's print stamp is for Cambodian staff/couriers. */
const PRINT_TIME_ZONE = "Asia/Phnom_Penh";

export type ParcelLabelPaymentState = "paid" | "cod" | "check";
export type ParcelLabelCheckReason =
  "settlement_unavailable" | "refunded" | "payment_review" | "payment_failed" | "payment_reversed";

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
  merchant: { businessName: string; phone?: string | null; logoUrl?: string | null };
  customer: {
    name: string | null;
    phone: string | null;
    address: string | null;
    /** False when there is no order shipping snapshot (§13). */
    addressConfirmed: boolean;
  };
  order: { id: string; orderNumber: string; itemCount: number; items: ParcelLabelItemInput[] };
  /** True when packing already advanced — a re-issue, shown as REPRINT (§19). */
  reprint: boolean;
  payment: {
    state: ParcelLabelPaymentState;
    paid?: boolean;
    collect: Money | null;
    partial?: boolean;
    checkReason?: ParcelLabelCheckReason | null;
  };
  delivery: {
    providerName: string;
    trackingNumber: string | null;
    status: string;
    serviceName?: string | null;
  } | null;
  /** The order's permanent parcel code (APSA:PCL:v1:<token>), or null if not yet assigned. */
  parcelCode?: string | null;
}

export interface ParcelLabelLine {
  quantity: number;
  productName: string;
  variantName: string | null;
  /** Concise one-line rendering, e.g. "2 × Iced Coffee — Large". */
  text: string;
}

export interface ParcelLabelViewModel {
  merchant: {
    name: string;
    phone: string | null;
    /** A safe-to-load logo URL, or null → text-only header. */
    logoUrl: string | null;
  };
  /** Kept for callers that only need the shop name. */
  merchantName: string;
  customer: {
    name: string | null;
    phone: string | null;
    address: string | null;
    addressConfirmed: boolean;
  };
  /** Long addresses print smaller so they wrap without crowding the label. */
  addressCompact: boolean;
  orderNumber: string;
  itemCount: number;
  reprint: boolean;
  items: ParcelLabelLine[];
  /** Lines beyond the budget that were not shown; 0 when everything fits (§15). */
  overflowCount: number;
  payment: {
    state: ParcelLabelPaymentState;
    /** Kept for compatibility: state === "paid". */
    paid: boolean;
    /** Formatted amount to collect — non-null ONLY when state is "cod". */
    collectFormatted: string | null;
    partial: boolean;
    checkReason: ParcelLabelCheckReason | null;
  };
  delivery: {
    carrierName: string;
    trackingNumber: string | null;
    serviceName: string | null;
  } | null;
  /** QR of the parcel identity; null until a parcel code exists. */
  qr: { payload: string; svg: string } | null;
  /** Code 128 of the SAME parcel identity; null until a parcel code exists. */
  code128: { payload: string; svg: string } | null;
  /** Human-readable parcel code, or null when not yet assigned. */
  parcelCode: string | null;
  /** ISO timestamp of when this label was generated. */
  printTimestamp: string;
  /** "2026-10-01 17:30" in Phnom Penh time, for the printed footer. */
  printedAt: string;
}

function formatItemLine(item: ParcelLabelItemInput): string {
  const base = `${item.quantity} × ${item.productName.trim()}`;
  const variant = item.variantName?.trim();
  return variant ? `${base} — ${variant}` : base;
}

function rowsFor(text: string): number {
  return text.length > ITEM_CHARS_PER_ROW ? 2 : 1;
}

/**
 * Only an https URL or an inline raster data URI may be loaded on a label —
 * never javascript:, http: (mixed content) or SVG data (script-capable).
 */
export function safeLogoUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (/^https:\/\/[^\s]+$/i.test(trimmed)) return trimmed;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) return trimmed;
  return null;
}

function formatPrintedAt(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: PRINT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export function buildParcelLabel(
  input: ParcelLabelInput,
  options: { maxItemLines?: number; now?: Date } = {},
): ParcelLabelViewModel {
  const maxLines = options.maxItemLines ?? PARCEL_LABEL_MAX_ITEM_LINES;
  const now = options.now ?? new Date();

  const address = input.customer.address;
  const addressCompact = (address?.length ?? 0) > PARCEL_LABEL_LONG_ADDRESS_CHARS;
  const rowBudget = addressCompact ? PARCEL_LABEL_ITEM_ROWS_COMPACT : PARCEL_LABEL_ITEM_ROWS;

  const allLines: ParcelLabelLine[] = input.order.items.map((item) => ({
    quantity: item.quantity,
    productName: item.productName,
    variantName: item.variantName,
    text: formatItemLine(item),
  }));

  const shown: ParcelLabelLine[] = [];
  let rowsUsed = 0;
  for (const line of allLines) {
    if (shown.length >= maxLines) break;
    const rows = rowsFor(line.text);
    // The continuation note needs its own row whenever lines remain hidden.
    const reserve = shown.length + 1 < allLines.length ? 1 : 0;
    if (rowsUsed + rows + reserve > rowBudget) break;
    shown.push(line);
    rowsUsed += rows;
  }
  const overflowCount = allLines.length - shown.length;

  // Codes: only ever the canonical parcel identity. A malformed or absent code
  // yields NO code rather than a fallback that could expose an order UUID.
  const parcelCode =
    input.parcelCode && isValidParcelCode(input.parcelCode) ? input.parcelCode : null;
  const qr = parcelCode
    ? {
        payload: parcelCode,
        svg: renderQrSvg(parcelCode, { moduleSize: 4, quietModules: 4, ecLevel: "M" }),
      }
    : null;
  const code128 =
    parcelCode && isCode128Encodable(parcelCode)
      ? {
          payload: parcelCode,
          svg: renderCode128Svg(parcelCode, { moduleWidth: 2, height: 40, quietModules: 10 }),
        }
      : null;

  // Payment: present exactly the server's decision. An amount is formatted ONLY
  // for COD; a COD with no amount is not trustworthy and degrades to CHECK.
  const p = input.payment;
  let state: ParcelLabelPaymentState = p.state;
  let checkReason: ParcelLabelCheckReason | null = p.checkReason ?? null;
  if (state === "cod" && !p.collect) {
    state = "check";
    checkReason = "settlement_unavailable";
  }
  if (state !== "paid" && state !== "cod" && state !== "check") {
    state = "check";
    checkReason = "settlement_unavailable";
  }
  if (state === "check" && !checkReason) checkReason = "settlement_unavailable";

  return {
    merchant: {
      name: input.merchant.businessName,
      phone: input.merchant.phone?.trim() || null,
      logoUrl: safeLogoUrl(input.merchant.logoUrl),
    },
    merchantName: input.merchant.businessName,
    customer: {
      name: input.customer.name,
      phone: input.customer.phone,
      address,
      addressConfirmed: input.customer.addressConfirmed,
    },
    addressCompact,
    orderNumber: input.order.orderNumber,
    itemCount: input.order.itemCount,
    reprint: input.reprint,
    items: shown,
    overflowCount,
    payment: {
      state,
      paid: state === "paid",
      collectFormatted: state === "cod" && p.collect ? formatMoney(p.collect) : null,
      partial: state === "cod" && p.partial === true,
      checkReason: state === "check" ? checkReason : null,
    },
    delivery: input.delivery
      ? {
          carrierName: input.delivery.providerName,
          trackingNumber: input.delivery.trackingNumber?.trim() || null,
          serviceName: input.delivery.serviceName?.trim() || null,
        }
      : null,
    qr,
    code128,
    parcelCode,
    printTimestamp: now.toISOString(),
    printedAt: formatPrintedAt(now),
  };
}
