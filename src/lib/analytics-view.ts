/**
 * Presentation rules for the Analytics screen — pure, browser-safe, testable.
 *
 * Every number the screen shows comes from src/server/analytics/service.ts
 * (via src/api/analytics.ts). This module decides only WHETHER a fetched value
 * may be shown for the range the merchant has selected, and formats what the
 * server already computed. It computes no business metric of its own, with one
 * narrowly-scoped exception documented on `averageOrderValue` below.
 */
import type { BusinessSummary, CustomerSummary, TopSellingItem } from "@/server/analytics/types";
import type { MetricRange, Money } from "@/types";

export type { BusinessSummary, CustomerSummary, TopSellingItem };

/** Exactly the ranges src/api/analytics.ts accepts — no custom range is offered. */
export const ANALYTICS_RANGES: readonly MetricRange[] = ["today", "week", "month"];

/** How many top sellers the V1 screen lists. */
export const ANALYTICS_TOP_SELLER_LIMIT = 5;

/** Top sellers carry no range of their own, so the client tags the page it asked for. */
export interface TopSellersPage {
  range: MetricRange;
  items: TopSellingItem[];
}

// ── Errors ────────────────────────────────────────────────────────────────────

export type AnalyticsErrorKind = "unauthorized" | "forbidden" | "error";

function statusCodeOf(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}

/**
 * Denied and failed are different answers. A 403 means this member may not
 * see Analytics at all; anything else is a failure that says nothing about the
 * business, and is never rendered as zero.
 */
export function classifyAnalyticsError(err: unknown): AnalyticsErrorKind {
  const code = statusCodeOf(err);
  const message = err instanceof Error ? err.message : "";
  if (code === 401 || /not authenticated/i.test(message)) return "unauthorized";
  if (code === 403 || /missing permission|no active organization membership/i.test(message)) {
    return "forbidden";
  }
  return "error";
}

// ── Range-safe view ───────────────────────────────────────────────────────────

export type AnalyticsSectionView<T> =
  { kind: "ready"; data: T } | { kind: "loading" } | { kind: "error"; error: AnalyticsErrorKind };

/**
 * The one place that decides whether fetched Analytics data may be shown as
 * the CURRENT range's numbers — the same rule Home uses
 * (src/lib/home-summary-view.ts).
 *
 * `data.range` is the range the payload actually describes. Anything else — a
 * previous range's payload still held while the new one loads, or a stale
 * payload beside an error — is never presented under the selected range's
 * label. An error with no data for this range is an error, never a zero.
 */
export function resolveAnalyticsSection<T extends { range: MetricRange }>(params: {
  range: MetricRange;
  data: T | undefined;
  isError: boolean;
  error: unknown;
}): AnalyticsSectionView<T> {
  const { range, data, isError, error } = params;
  if (data && data.range === range) return { kind: "ready", data };
  if (isError) return { kind: "error", error: classifyAnalyticsError(error) };
  return { kind: "loading" };
}

/**
 * An empty period is a real answer only when the server SAID so: the business
 * summary loaded for this range and counted no qualifying order. Loading and
 * failure are never "empty".
 */
export function isEmptyPeriod(view: AnalyticsSectionView<BusinessSummary>): boolean {
  return view.kind === "ready" && view.data.orderCount === 0;
}

// ── Derived presentation ──────────────────────────────────────────────────────

/**
 * The sentence shown in place of money the server did not give. A withheld,
 * partial or failed finance section is SAID — never printed as zeros, because
 * a fabricated 0 is indistinguishable from "no sales" (for a Sales member
 * outside the financial boundary, it would simply be a lie).
 */
export function financeUnavailableKey(
  status: Exclude<BusinessSummary["finance"]["status"], "available">,
): "analytics.money.hidden" | "analytics.money.partial" | "analytics.money.error" {
  if (status === "permission_denied") return "analytics.money.hidden";
  if (status === "truncated") return "analytics.money.partial";
  return "analytics.money.error";
}

/**
 * Average order value, or null when it cannot be stated honestly.
 *
 * The backend does not return an average. It returns `orderedGross` (Money per
 * currency) and `orderCount` for the SAME cohort of confirmed/completed orders.
 * When every one of those orders is in one currency — `orderedGross` has a
 * single entry — the average is that entry divided by the count, and that is
 * all this function does.
 *
 * It refuses (returns null) whenever the division would be a guess:
 *   - money withheld or failed on the server (`finance` not available);
 *   - no orders (there is no average of nothing);
 *   - more than one currency — `orderCount` is not split by currency, so no
 *     per-currency average exists, and a cross-currency one would be an FX
 *     judgement with no rate.
 *
 * Integer arithmetic only (BigInt, round half up), never float money math.
 */
export function averageOrderValue(summary: BusinessSummary): Money | null {
  if (summary.finance.status !== "available") return null;
  if (summary.orderCount <= 0) return null;
  const gross = summary.finance.data.orderedGross;
  if (gross.length !== 1) return null;
  const only = gross[0]!;
  const total = BigInt(only.amount);
  const count = BigInt(summary.orderCount);
  const rounded = (total * 2n + count) / (count * 2n);
  return { amount: Number(rounded), currency: only.currency };
}

/**
 * Repeat-order rate as a whole percent, or null when the server said the rate
 * is undefined (no attributed order in the period) — never a manufactured 0%.
 */
export function repeatRatePercent(rate: number | null): number | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return Math.round(rate * 100);
}

// ── Time range caption ────────────────────────────────────────────────────────

/** The server computes every range on the Cambodia calendar (src/server/home/service.ts). */
export const ANALYTICS_TIME_ZONE = "Asia/Phnom_Penh";

export interface CalendarDay {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
}

/** The Cambodia-calendar date of an instant. Numeric parts only — supported by every Intl build. */
export function phnomPenhDay(instant: Date): CalendarDay {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ANALYTICS_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

/**
 * The exact period the server measured, as the merchant reads it: first day to
 * last day, on the Cambodia calendar.
 *
 * `until` is EXCLUSIVE (midnight that starts the next period), so the last day
 * is the day before it. `last` is null when the period is a single day.
 *
 * Returns date parts rather than a formatted string: month NAMES come from the
 * locale files (analytics.months.*), because browser Intl data for Khmer is not
 * guaranteed — a Chromium build without it silently prints English months on
 * a Khmer screen.
 */
export function analyticsPeriodDays(
  from: string,
  until: string,
): { first: CalendarDay; last: CalendarDay | null } {
  const first = phnomPenhDay(new Date(from));
  const last = phnomPenhDay(new Date(new Date(until).getTime() - 1));
  const same = first.year === last.year && first.month === last.month && first.day === last.day;
  return { first, last: same ? null : last };
}
