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
 *   - is the SHIPPING label (CORRECTION-003): it exists for a carrier shipment.
 *     Its PRIMARY barcode is the carrier TRACKING number (full-width Code 128)
 *     — what the courier scans. A SMALL APSA Parcel QR plus the Parcel ID are
 *     the merchant's secondary, internal identifier (the full-size APSA codes
 *     live on the internal parcel label, ./internal-parcel-label.ts). The label
 *     never prints an order UUID.
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

/** Hard cap on product lines, independent of the height budget. */
export const PARCEL_LABEL_MAX_ITEM_LINES = 8;

/** Above this many characters the address prints in the compact size. */
export const PARCEL_LABEL_LONG_ADDRESS_CHARS = 140;

/**
 * Hard cap on the printed address, in characters (grapheme-safe). The DB
 * allows 1000; anything beyond this is cut at a whole grapheme and the label
 * says so — never silently.
 */
export const PARCEL_LABEL_ADDRESS_MAX_CHARS = 300;

/** Most address lines printed (normal / compact size); fewer when space is short. */
export const PARCEL_LABEL_ADDRESS_LINES = 4;
export const PARCEL_LABEL_ADDRESS_LINES_COMPACT = 6;
/** The address always keeps at least this many lines. */
const ADDRESS_MIN_LINES = 2;

/**
 * ── VERTICAL BUDGET (mm) ──────────────────────────────────────────────────────
 *
 * The component splits the 150 mm page into a FIXED bottom block (payment + 30
 * mm QR, full-width Code 128, footer) that always keeps its full height, and a
 * TOP block that gets only what is left and clips inside itself. So nothing in
 * the top block can ever reach the payment box or push the codes off the page.
 *
 * The figures below are the top block's own CSS (font size × line-height in
 * pt → mm, plus paddings/rules) so buildParcelLabel can decide — before
 * anything renders, the same way on every printer — how many address lines and
 * item lines fit, instead of letting them be clipped:
 *
 *   - every text block is line-clamped in CSS, so its height can never exceed
 *     `clamp × line-height` whatever the font;
 *   - the number of lines a text needs is estimated with a deliberately LOW
 *     characters-per-line figure, so the estimate errs high (less shown, never
 *     clipped).
 *
 * Whatever does not fit is reported: "+N more" for items, a visible marker
 * for a shortened address.
 */
const PT = 25.4 / 72;
/** Top block height: 150 − 2×4 padding − bottom block (53.6) − 1.5 gap, less a safety margin. */
const TOP_BLOCK_MM = 86.2;
const GAP_MM = 1.5;
/** Section padding-bottom (1.5) + rule (0.4). */
const RULE_MM = 1.9;
const lineMm = (pt: number, leading: number) => pt * leading * PT;
const CAPTION_MM = lineMm(7, 1.25);
const SHOP_LINE_MM = lineMm(11, 1.25);
const SHOP_PHONE_MM = lineMm(9, 1.25);
const LOGO_MM = 11;
const NAME_LINE_MM = lineMm(15, 1.25);
const PHONE_MM = lineMm(13, 1.25);
const ADDRESS_LINE_MM = lineMm(10.5, 1.375);
const ADDRESS_LINE_COMPACT_MM = lineMm(9, 1.375);
const NOTE_MM = 0.5 + lineMm(7, 1.25);
const UNCONFIRMED_MM = 0.5 + 1.6 + 2 * lineMm(7, 1.25);
const CARRIER_LINE_MM = lineMm(9, 1.25);
const ITEMS_HEADER_MM = lineMm(8, 1.25) + 0.5;
const ITEM_ROW_MM = lineMm(9, 1.25);
const ITEM_GAP_MM = 0.4;
const MORE_MM = 0.5 + lineMm(8, 1.25);

/** Low characters-per-line figures (92 mm wide) — estimates err toward MORE lines. */
const CPL = { shop: 22, name: 18, address: 30, addressCompact: 36, carrier: 36, item: 36 };
/** Room the translated carrier/tracking captions take on the carrier line. */
const CARRIER_CAPTION_CHARS = 28;

/** Estimated printed lines of `text` (newlines kept), capped at `max`. */
function linesFor(text: string, cpl: number, max: number, extraChars = 0): number {
  const needed = text
    .split("\n")
    .reduce(
      (sum, para, i) =>
        sum + Math.max(1, Math.ceil((para.trim().length + (i === 0 ? extraChars : 0)) / cpl)),
      0,
    );
  return Math.min(max, Math.max(1, needed));
}

function rowsFor(text: string): number {
  return text.length > CPL.item ? 2 : 1;
}

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
    /** The shipment's id (server label data always carries it). */
    id?: string;
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
  /** CSS line clamp for the address — what the vertical budget allows. */
  addressLines: number;
  /** True when the printed address may be shortened (see the full order). */
  addressTruncated: boolean;
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
  /**
   * Code 128 of the carrier TRACKING number — the courier's identifier. Null
   * without a tracking number (or one Code 128 cannot encode).
   */
  trackingCode128: { payload: string; svg: string } | null;
  /**
   * SMALL QR of the APSA Parcel ID — the merchant's internal identifier,
   * secondary to the tracking barcode. Null without a valid parcel code.
   */
  apsaQr: { payload: string; svg: string } | null;
  /** The APSA Parcel ID, printed as secondary text only (never scannable here). */
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

/**
 * Shorten to at most `max` characters at a grapheme boundary, so a Khmer
 * consonant cluster (base + subscripts + vowel signs) is never split.
 */
function truncateGraphemes(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(text)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out.trimEnd();
}

export function formatPrintedAt(now: Date): string {
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

  const rawAddress = input.customer.address;
  const addressCompact = (rawAddress?.length ?? 0) > PARCEL_LABEL_LONG_ADDRESS_CHARS;
  const hardCut = (rawAddress?.length ?? 0) > PARCEL_LABEL_ADDRESS_MAX_CHARS;
  const address =
    rawAddress && hardCut
      ? `${truncateGraphemes(rawAddress, PARCEL_LABEL_ADDRESS_MAX_CHARS)}…`
      : rawAddress;

  const allLines: ParcelLabelLine[] = input.order.items.map((item) => ({
    quantity: item.quantity,
    productName: item.productName,
    variantName: item.variantName,
    text: formatItemLine(item),
  }));

  // ── Vertical budget: fixed sections first, then address, then items. ──────
  const shopName = input.merchant.businessName.trim();
  const shopPhone = input.merchant.phone?.trim() || null;
  const headerText =
    CAPTION_MM +
    linesFor(shopName || " ", CPL.shop, 2) * SHOP_LINE_MM +
    (shopPhone ? SHOP_PHONE_MM : 0);
  const header = Math.max(headerText, safeLogoUrl(input.merchant.logoUrl) ? LOGO_MM : 0) + RULE_MM;

  const name = input.customer.name?.trim() ?? "";
  const receiverFixed =
    CAPTION_MM +
    (name ? linesFor(name, CPL.name, 2) * NAME_LINE_MM : 0) +
    (input.customer.phone ? PHONE_MM : 0) +
    (input.customer.addressConfirmed ? 0 : UNCONFIRMED_MM) +
    RULE_MM;

  const d = input.delivery;
  const carrierText = d ? `${d.providerName} ${d.serviceName ?? ""} ${d.trackingNumber ?? ""}` : "";
  const carrier =
    linesFor(carrierText, CPL.carrier, 2, CARRIER_CAPTION_CHARS) * CARRIER_LINE_MM + RULE_MM;

  const itemsFixed = ITEMS_HEADER_MM + RULE_MM;
  // Items keep at least one line plus the "+N more" note when any exist.
  const itemsMinimum =
    allLines.length > 0
      ? rowsFor(allLines[0]!.text) * ITEM_ROW_MM + (allLines.length > 1 ? MORE_MM : 0)
      : 0;

  const addressLineMm = addressCompact ? ADDRESS_LINE_COMPACT_MM : ADDRESS_LINE_MM;
  const addressCap = addressCompact
    ? PARCEL_LABEL_ADDRESS_LINES_COMPACT
    : PARCEL_LABEL_ADDRESS_LINES;
  const addressNeed = address
    ? linesFor(address, addressCompact ? CPL.addressCompact : CPL.address, Number.MAX_SAFE_INTEGER)
    : 0;
  const beforeAddress = header + receiverFixed + carrier + itemsFixed + 3 * GAP_MM;
  // Lines the address may take: as many as it needs, up to its cap, never
  // eating the items' minimum (but always at least ADDRESS_MIN_LINES).
  const addressRoomForLines = (withNote: boolean) =>
    Math.floor(
      (TOP_BLOCK_MM - beforeAddress - itemsMinimum - 0.5 - (withNote ? NOTE_MM : 0)) /
        addressLineMm,
    );
  let addressLines = address ? Math.min(addressNeed, addressCap) : 1;
  let addressTruncated = hardCut;
  if (address) {
    if (addressNeed > addressCap) addressTruncated = true;
    if (addressLines > addressRoomForLines(addressTruncated)) {
      addressTruncated = true;
      addressLines = Math.max(
        Math.min(ADDRESS_MIN_LINES, addressNeed),
        Math.min(addressLines, addressRoomForLines(true)),
      );
    }
  }
  const receiver =
    receiverFixed +
    0.5 +
    addressLines * (address ? addressLineMm : ADDRESS_LINE_COMPACT_MM) +
    (addressTruncated ? NOTE_MM : 0);

  const itemsRoom = TOP_BLOCK_MM - (header + receiver + carrier + itemsFixed + 3 * GAP_MM);
  const shown: ParcelLabelLine[] = [];
  let usedMm = 0;
  for (const line of allLines) {
    if (shown.length >= maxLines) break;
    const cost = (shown.length > 0 ? ITEM_GAP_MM : 0) + rowsFor(line.text) * ITEM_ROW_MM;
    // The "+N more" note needs its own room whenever lines remain hidden.
    const reserve = shown.length + 1 < allLines.length ? MORE_MM : 0;
    if (usedMm + cost + reserve > itemsRoom) break;
    shown.push(line);
    usedMm += cost;
  }
  const overflowCount = allLines.length - shown.length;

  // Secondary APSA Parcel ID (text only). A malformed code is dropped rather
  // than printed, and nothing ever falls back to an order UUID.
  const parcelCode =
    input.parcelCode && isValidParcelCode(input.parcelCode) ? input.parcelCode : null;
  // The shipping label's one barcode: the carrier tracking number.
  const tracking = input.delivery?.trackingNumber?.trim() || null;
  const trackingCode128 =
    tracking && isCode128Encodable(tracking)
      ? {
          payload: tracking,
          svg: renderCode128Svg(tracking, { moduleWidth: 2, height: 40, quietModules: 10 }),
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
    addressLines,
    addressTruncated,
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
    trackingCode128,
    apsaQr: parcelCode
      ? {
          payload: parcelCode,
          svg: renderQrSvg(parcelCode, { moduleSize: 4, quietModules: 4, ecLevel: "M" }),
        }
      : null,
    parcelCode,
    printTimestamp: now.toISOString(),
    printedAt: formatPrintedAt(now),
  };
}
