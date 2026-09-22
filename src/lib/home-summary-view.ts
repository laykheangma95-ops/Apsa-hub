import type { HomeSummary, MetricRange } from "@/types";

/**
 * What Home should show for the currently selected range.
 *
 * - `ready`   — `summary` was fetched FOR the selected range. Safe to render.
 * - `loading` — no data for the selected range yet (first load, or a range
 *   switch still in flight). Never carries a summary, even if one exists in
 *   `data` — see below.
 * - `error`   — the fetch for the selected range failed and there is no
 *   summary for that range to fall back to.
 */
export type HomeSummaryView =
  { kind: "ready"; summary: HomeSummary } | { kind: "loading" } | { kind: "error" };

/**
 * The single place that decides whether fetched Home data may be shown as
 * the CURRENT range's numbers.
 *
 * `data` may be stale — react-query's `placeholderData`/`keepPreviousData`
 * (or any future equivalent) can hand back the PREVIOUS range's summary
 * while a new range is already selected and its own fetch is in flight.
 * `data.range` is the range that summary actually describes, so comparing it
 * against the range the merchant currently has selected is the one check
 * that keeps one range's numbers from ever being presented under another
 * range's label — including the failure case, where stale data must not
 * sit next to an error for the range that is actually selected.
 */
export function resolveHomeSummaryView(params: {
  range: MetricRange;
  data: HomeSummary | undefined;
  isError: boolean;
}): HomeSummaryView {
  const { range, data, isError } = params;

  if (data && data.range === range) {
    return { kind: "ready", summary: data };
  }
  if (isError) return { kind: "error" };
  return { kind: "loading" };
}
