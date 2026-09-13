import type { AttentionItem, HomeSummary } from "@/types";

/**
 * The Home sections that can contribute a "needs attention" row. Finance is
 * deliberately absent: it is a period total in the overview, not work queued
 * for the merchant.
 */
export const ATTENTION_SECTIONS = ["orders", "payments", "inventory", "delivery"] as const;

/**
 * How much of the attention picture Home actually has.
 *
 * - `complete`    — every section the member can access answered successfully.
 * - `incomplete`  — at least one accessible section errored or was truncated,
 *                   so an empty list means "not known", not "nothing to do".
 * - `unavailable` — the member can access none of the attention sections, so
 *                   Home has nothing to be silent or reassuring about.
 */
export type AttentionCompleteness = "complete" | "incomplete" | "unavailable";

/**
 * A denied section is a normal, permission-aware partial view — never an
 * error, and never a reason to withhold a truthful "nothing needs attention"
 * from the sections the member can actually see.
 */
export function attentionCompleteness(summary: HomeSummary): AttentionCompleteness {
  let accessible = 0;
  let unfinished = 0;

  for (const section of ATTENTION_SECTIONS) {
    const status = summary[section].status;
    if (status === "permission_denied") continue;
    accessible += 1;
    // "error" and "truncated" both mean the count Home holds is not the count
    // that exists, so neither may be reported as a settled zero.
    if (status !== "available") unfinished += 1;
  }

  if (accessible === 0) return "unavailable";
  return unfinished > 0 ? "incomplete" : "complete";
}

/**
 * The single line under the attention list, or `null` when the cards speak for
 * themselves. Returning a key rather than a string keeps the decision testable
 * and the copy in the locale files.
 *
 * The clean zero-attention claim is reachable through exactly one path: no
 * attention rows AND a complete picture.
 */
export function attentionNoticeKey(
  summary: HomeSummary,
  attentionCount: number,
): "home.noAttention" | "home.attentionIncomplete" | "home.attentionUnavailable" | null {
  const completeness = attentionCompleteness(summary);

  if (completeness === "unavailable") return "home.attentionUnavailable";
  // Said whether or not rows are showing: a partial list is still partial.
  if (completeness === "incomplete") return "home.attentionIncomplete";
  return attentionCount === 0 ? "home.noAttention" : null;
}

/**
 * The attention rows a Home summary actually supports.
 *
 * Moved out of the Home screen so the bottom bar's Home dot and Home's own
 * cards answer from one derivation instead of two that can drift: a dot that
 * says "something needs you" while Home shows nothing is worse than no dot.
 *
 * Only sections reported `available` contribute. A denied or errored section
 * contributes nothing here and is described by attentionNoticeKey instead —
 * an unknown count must never be rendered as a zero or as a row.
 */
export function homeAttentionItems(summary: HomeSummary): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (summary.orders.status === "available") {
    if (summary.orders.data.awaitingPaymentCount > 0) {
      items.push({
        id: "awaiting_payment",
        count: summary.orders.data.awaitingPaymentCount,
        tone: "warning",
      });
    }
    if (summary.orders.data.actionNeededCount > 0) {
      items.push({
        id: "orders_needing_action",
        count: summary.orders.data.actionNeededCount,
        tone: "warning",
      });
    }
  }

  if (summary.payments.status === "available" && summary.payments.data.needsReviewCount > 0) {
    items.push({
      id: "payments_needing_review",
      count: summary.payments.data.needsReviewCount,
      tone: "danger",
    });
  }

  if (
    summary.inventory.status === "available" &&
    summary.inventory.data.outOfStockVariantCount > 0
  ) {
    items.push({
      id: "low_stock",
      count: summary.inventory.data.outOfStockVariantCount,
      tone: "danger",
    });
  }

  if (summary.delivery.status === "available" && summary.delivery.data.actionCount > 0) {
    items.push({
      id: "awaiting_delivery",
      count: summary.delivery.data.actionCount,
      tone: "info",
    });
  }

  return items;
}

/**
 * Whether the Home tab should wear its dot.
 *
 * A dot, not a count, and only for work Home can actually stand behind: an
 * incomplete picture is not evidence of attention, so it does not light the
 * dot. Home's own notice line is where "I could not check" is said out loud.
 */
export function homeHasAttention(summary: HomeSummary): boolean {
  return homeAttentionItems(summary).length > 0;
}
