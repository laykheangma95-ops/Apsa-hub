/**
 * Analytics cache identity.
 *
 * Analytics lives INSIDE Home's cache root on purpose, not beside it:
 *
 *   1. It is the same read-model family. src/server/analytics/service.ts reuses
 *      Home's Cambodia-calendar range contract (`rangeBounds`) and Home's
 *      financial visibility boundary (`canReadFinancials`); its numbers move
 *      whenever Home's do, for the same reasons.
 *   2. Every commerce write in the app already invalidates `HOME_QUERY_PREFIX`
 *      after it succeeds — POS checkout, order create, confirm/cancel, payment
 *      record/verify/refund, delivery transitions, stock movements. Nesting
 *      here means each of those refreshes Analytics too, with no second list of
 *      invalidation sites that could drift from the first.
 *   3. `enforceHomeCachePrincipal` (src/routes/app.tsx) already drops this whole
 *      root the moment the signed-in user or active organization changes, and
 *      Settings' sign-out already calls `clearHomeQueries`. A previous
 *      principal's analytics can therefore never be served to the next one —
 *      not even for a frame.
 *
 * Partitioned by user AND organization, like Home: the money inside a
 * BusinessSummary depends on the member's own grants (the server withholds it
 * as `permission_denied` for a member outside the financial boundary), so two
 * members of one organization must never share an entry.
 *
 * Cache identity only. Nothing here is sent to the server; src/api/analytics.ts
 * resolves the user from the session and the organization from the active
 * membership, and requires `analytics.read` on every call.
 *
 * Safe to bundle for the browser.
 */
import { HOME_QUERY_PREFIX } from "@/lib/home-query";
import type { MetricRange } from "@/types";

/** The segment that separates Analytics entries from Home's own range entries. */
export const ANALYTICS_QUERY_SEGMENT = "analytics";

export const analyticsKeys = {
  /** Every Analytics entry this principal holds, for every range. */
  principal: (userId: string, organizationId: string) =>
    [...HOME_QUERY_PREFIX, userId, organizationId, ANALYTICS_QUERY_SEGMENT] as const,
  /** Business summary (orders, money, status mixes) for one range. */
  summary: (userId: string, organizationId: string, range: MetricRange) =>
    [
      ...HOME_QUERY_PREFIX,
      userId,
      organizationId,
      ANALYTICS_QUERY_SEGMENT,
      "summary",
      range,
    ] as const,
  /** Top sellers for one range. `limit` is part of the identity: a top-5 is not a top-20. */
  topSellers: (userId: string, organizationId: string, range: MetricRange, limit: number) =>
    [
      ...HOME_QUERY_PREFIX,
      userId,
      organizationId,
      ANALYTICS_QUERY_SEGMENT,
      "top-sellers",
      range,
      limit,
    ] as const,
  /** New / returning customer cohort for one range. */
  customers: (userId: string, organizationId: string, range: MetricRange) =>
    [
      ...HOME_QUERY_PREFIX,
      userId,
      organizationId,
      ANALYTICS_QUERY_SEGMENT,
      "customers",
      range,
    ] as const,
};
