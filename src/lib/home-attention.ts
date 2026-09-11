import type { HomeSummary } from "@/types";

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
