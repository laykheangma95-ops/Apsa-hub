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
  /** All payments ever recorded, regardless of status/verification. */
  expectedRevenue: ReconciliationBucket;
  paid: ReconciliationBucket;
  pending: ReconciliationBucket;
  failed: ReconciliationBucket;
  reversed: ReconciliationBucket;
  refunded: ReconciliationBucket;
  /** verification_state = 'bank_verified'. */
  bankVerified: ReconciliationBucket;
  /** verification_state = 'manager_verified'. */
  managerVerified: ReconciliationBucket;
  /** verification_state = 'staff_confirmed' and never escalated further. */
  staffConfirmedOnly: ReconciliationBucket;
  /** method = 'cod' and status = 'pending' — collected in the field, not yet settled. */
  codUnsettled: ReconciliationBucket;
  /** verification_state IN ('mismatch', 'duplicate_suspected'), or pending+unverified. */
  needsReview: ReconciliationBucket;
  /** verification_state = 'duplicate_suspected' specifically. */
  duplicateSuspected: ReconciliationBucket;
  /** verification_state = 'mismatch' specifically. */
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

    addToBucket(summary.expectedRevenue, row);

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

    if (row.method === "cod" && row.status === "pending") {
      addToBucket(summary.codUnsettled, row);
    }
  }

  return Array.from(byCurrency.values());
}
