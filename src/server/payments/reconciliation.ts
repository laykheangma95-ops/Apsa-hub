/**
 * Reconciliation foundation — backend data/query capability only.
 *
 * NO DASHBOARD UI. This module exists so an owner-facing screen can later be
 * built on top of it; it does not build that screen (per the task brief:
 * "Do NOT build dashboard UI yet").
 *
 * Uses neutral labels ("needs_review") rather than accusatory ones — this
 * module never labels a payment as theft or fraud; it surfaces facts for a
 * human to interpret (SECURITY.md: "Do not accuse staff of theft/fraud").
 *
 * Built entirely on payment_reconciliation_summary (migration 034), a live
 * derived view over the payments table — never a maintained/cached balance,
 * same philosophy as inventory_stock.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import * as repo from "./repository";
import type { Money, Currency } from "@/types";
import type { PaymentReconciliationRow } from "./types";

export interface ReconciliationBucket {
  count: number;
  amount: Money;
}

export interface ReconciliationSummary {
  currency: Currency;
  /**
   * DEFINITION (documented explicitly — see task history for why this needed
   * clarifying): the gross value of payment claims that either arrived or are
   * still awaiting a verdict — `status IN ('pending', 'paid', 'refunded')`.
   *
   * EXCLUDES `reversed` — a reversed payment was voided before or instead of
   * settling; it never became revenue and must not inflate this figure.
   *
   * EXCLUDES `failed` — a `failed` payment is the result of a `mismatch`
   * verification (see ./state-machine#resultingPaymentStatus): the claim was
   * specifically found NOT to hold up. Like `reversed`, it never became real
   * money and does not belong in an "expected" figure.
   *
   * INCLUDES `refunded` (gross, pre-refund) — a refunded payment genuinely
   * arrived and settled as `paid` before later being returned. Excluding it
   * here would erase the fact that the sale happened; instead, subtract the
   * `refunded` bucket from this figure to get a NET expected-revenue number.
   * This is a deliberate choice, not an oversight — see the `refunded` field.
   */
  expectedRevenue: ReconciliationBucket;
  paid: ReconciliationBucket;
  pending: ReconciliationBucket;
  failed: ReconciliationBucket;
  reversed: ReconciliationBucket;
  /**
   * Gross amount later returned via refund_payment_v1 (partial or full).
   * Already included in `expectedRevenue` (see its definition above) — this
   * bucket exists so a consumer can compute `expectedRevenue - refunded` for
   * a NET figure. Do not add this to `expectedRevenue` again.
   */
  refunded: ReconciliationBucket;
  /**
   * verification_state = 'bank_verified' AND status = 'paid' — i.e. money
   * that is CURRENTLY live at this trust tier. A payment that was
   * bank-verified and later reversed or refunded is deliberately excluded:
   * it no longer represents money the organization holds, so counting it
   * here would overstate current bank-verified funds.
   */
  bankVerified: ReconciliationBucket;
  /** Same "currently live" rule as bankVerified, for verification_state = 'manager_verified'. */
  managerVerified: ReconciliationBucket;
  /**
   * Same "currently live" rule as bankVerified, for verification_state =
   * 'staff_confirmed' — i.e. confirmed by a human with no higher escalation,
   * and not since reversed or refunded.
   */
  staffConfirmedOnly: ReconciliationBucket;
  /** method = 'cod' and status = 'pending' — collected in the field, not yet settled. */
  codUnsettled: ReconciliationBucket;
  /**
   * Currently-actionable review items only: verification_state IN
   * ('mismatch', 'duplicate_suspected'), or pending+unverified — EXCLUDING
   * any payment already reversed or refunded, since voiding or refunding it
   * already resolved whatever needed reviewing.
   */
  needsReview: ReconciliationBucket;
  /** verification_state = 'duplicate_suspected' and not since reversed/refunded. */
  duplicateSuspected: ReconciliationBucket;
  /** verification_state = 'mismatch' and not since reversed/refunded. */
  mismatch: ReconciliationBucket;
}

function emptyBucket(currency: Currency): ReconciliationBucket {
  return { count: 0, amount: { amount: 0, currency } };
}

function addToBucket(bucket: ReconciliationBucket, row: PaymentReconciliationRow): void {
  bucket.count += row.payment_count;
  bucket.amount.amount += row.amount_minor_total;
}

/**
 * Build a per-currency reconciliation summary for the caller's organization.
 *
 * Two currencies (USD/KHR) are never summed together — ARCHITECTURE.md
 * forbids inventing an implicit exchange rate; a caller wanting a single
 * blended figure must apply an explicit, recorded conversion rate itself.
 */
export async function getReconciliationSummary(
  ctx: AuthorizationContext,
): Promise<ReconciliationSummary[]> {
  ctx.require("payments.reconcile");

  const rows = await repo.getReconciliationSummary(ctx.organizationId);
  const byCurrency = new Map<Currency, ReconciliationSummary>();

  function summaryFor(currency: Currency): ReconciliationSummary {
    let summary = byCurrency.get(currency);
    if (!summary) {
      summary = {
        currency,
        expectedRevenue: emptyBucket(currency),
        paid: emptyBucket(currency),
        pending: emptyBucket(currency),
        failed: emptyBucket(currency),
        reversed: emptyBucket(currency),
        refunded: emptyBucket(currency),
        bankVerified: emptyBucket(currency),
        managerVerified: emptyBucket(currency),
        staffConfirmedOnly: emptyBucket(currency),
        codUnsettled: emptyBucket(currency),
        needsReview: emptyBucket(currency),
        duplicateSuspected: emptyBucket(currency),
        mismatch: emptyBucket(currency),
      };
      byCurrency.set(currency, summary);
    }
    return summary;
  }

  for (const row of rows) {
    const summary = summaryFor(row.currency as Currency);

    // expectedRevenue: pending + paid + refunded only. 'reversed' was voided
    // and never became revenue; 'failed' is the status a 'mismatch'
    // verification always produces (see state-machine#resultingPaymentStatus)
    // and equally never became real money. See the field's own doc comment.
    if (row.status === "pending" || row.status === "paid" || row.status === "refunded") {
      addToBucket(summary.expectedRevenue, row);
    }

    switch (row.status) {
      case "paid":
        addToBucket(summary.paid, row);
        break;
      case "pending":
        addToBucket(summary.pending, row);
        break;
      case "failed":
        addToBucket(summary.failed, row);
        break;
      case "reversed":
        addToBucket(summary.reversed, row);
        break;
      case "refunded":
        addToBucket(summary.refunded, row);
        break;
    }

    // "Currently live" gate: reverse_payment_v1 / refund_payment_v1 never
    // touch verification_state (migration 035), so a reversed or refunded
    // payment can still carry a verification_state of 'staff_confirmed',
    // 'bank_verified', 'mismatch', etc. from before it was voided/returned.
    // None of the trust-tier or review buckets below should count that money
    // — it no longer exists as a live balance and nothing about it still
    // "needs review". Excluding both statuses here is what fixes the bug
    // where a reversed/refunded payment inflated bankVerified/
    // managerVerified/staffConfirmedOnly/needsReview/duplicateSuspected/mismatch.
    const isLive = row.status !== "reversed" && row.status !== "refunded";

    if (isLive) {
      switch (row.verification_state) {
        case "bank_verified":
          addToBucket(summary.bankVerified, row);
          break;
        case "manager_verified":
          addToBucket(summary.managerVerified, row);
          break;
        case "staff_confirmed":
          addToBucket(summary.staffConfirmedOnly, row);
          break;
        case "duplicate_suspected":
          addToBucket(summary.duplicateSuspected, row);
          addToBucket(summary.needsReview, row);
          break;
        case "mismatch":
          addToBucket(summary.mismatch, row);
          addToBucket(summary.needsReview, row);
          break;
        case "unverified":
          if (row.status === "pending") addToBucket(summary.needsReview, row);
          break;
      }
    }

    if (row.method === "cod" && row.status === "pending") {
      addToBucket(summary.codUnsettled, row);
    }
  }

  return Array.from(byCurrency.values());
}
