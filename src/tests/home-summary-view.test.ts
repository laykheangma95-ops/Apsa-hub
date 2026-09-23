/**
 * Home's range-display decision — regression coverage for the P2 defect
 * where switching Today/Week/Month could show one range's numbers under
 * another range's label (or, worse, stale numbers sitting next to an error
 * for the newly-selected range).
 *
 * resolveHomeSummaryView (src/lib/home-summary-view.ts) is the single place
 * allowed to decide whether fetched data may be presented as the CURRENT
 * range's truth. These tests drive that real function directly, so a
 * regression — `placeholderData: keepPreviousData` reintroduced on the
 * query, or any other stale-range rendering — shows up here even before it
 * reaches a screen.
 *
 * Run: bun test src/tests/home-summary-view.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { resolveHomeSummaryView } from "@/lib/home-summary-view";
import type { HomeSummary, MetricRange } from "@/types";

const ROOT = process.cwd();
const readSource = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), "utf-8");

function summaryFor(range: MetricRange, awaitingPaymentCount: number): HomeSummary {
  return {
    range,
    orders: {
      status: "available",
      data: { periodCount: awaitingPaymentCount, awaitingPaymentCount, actionNeededCount: 0 },
    },
    payments: { status: "available", data: { needsReviewCount: 0 } },
    finance: { status: "available", data: { netCollectedForCreatedOrders: [] } },
    inventory: { status: "available", data: { outOfStockVariantCount: 0 } },
    delivery: { status: "available", data: { actionCount: 0 } },
  };
}

describe("resolveHomeSummaryView — the five required states", () => {
  it("current range + matching data -> shows the data", () => {
    const today = summaryFor("today", 3);
    const view = resolveHomeSummaryView({ range: "today", data: today, isError: false });
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") expect(view.summary).toBe(today);
  });

  it("changed range + previous range's data still in flight -> never presents it as the new range", () => {
    // range switched to "week" but the query object still holds "today"'s
    // summary (exactly what placeholderData: keepPreviousData would hand back).
    const staleToday = summaryFor("today", 3);
    const view = resolveHomeSummaryView({ range: "week", data: staleToday, isError: false });
    expect(view.kind).toBe("loading");
    // Never "ready" with the wrong range's summary.
    expect(view.kind === "ready").toBe(false);
  });

  it("changed range + error -> never presents old range values as current", () => {
    const staleToday = summaryFor("today", 3);
    const view = resolveHomeSummaryView({ range: "month", data: staleToday, isError: true });
    expect(view.kind).toBe("error");
    if (view.kind === "ready") throw new Error("must not be ready with mismatched-range data");
  });

  it("same-range background refresh may keep showing the current, matching data", () => {
    const week = summaryFor("week", 7);
    // isFetching is deliberately not a parameter: matching data is safe to
    // show regardless of whether a background refetch is in flight.
    const view = resolveHomeSummaryView({ range: "week", data: week, isError: false });
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") expect(view.summary.range).toBe("week");
  });

  it("initial load: no data yet, no error -> loading, not an empty ready state", () => {
    const view = resolveHomeSummaryView({ range: "today", data: undefined, isError: false });
    expect(view.kind).toBe("loading");
  });

  it("a genuine error with nothing cached for this range at all -> error, not loading forever", () => {
    const view = resolveHomeSummaryView({ range: "today", data: undefined, isError: true });
    expect(view.kind).toBe("error");
  });

  it("a same-range error that still holds this range's last-good data stays ready", () => {
    // A background refetch of the SAME range can fail while react-query keeps
    // the last successful data around. That data is still honestly this
    // range's — only a range MISMATCH must suppress it.
    const month = summaryFor("month", 1);
    const view = resolveHomeSummaryView({ range: "month", data: month, isError: true });
    expect(view.kind).toBe("ready");
  });
});

describe("resolveHomeSummaryView is exhaustive over every range pairing", () => {
  const RANGES: MetricRange[] = ["today", "week", "month"];

  it("is ready only when data.range equals the selected range, for every pairing", () => {
    for (const selected of RANGES) {
      for (const dataRange of RANGES) {
        const view = resolveHomeSummaryView({
          range: selected,
          data: summaryFor(dataRange, 1),
          isError: false,
        });
        expect(view.kind).toBe(selected === dataRange ? "ready" : "loading");
      }
    }
  });
});

describe("the route is wired to the decision, not to keepPreviousData", () => {
  const ROUTE = "src/routes/app.index.tsx";

  it("does not use keepPreviousData (or import it) on the Home query", () => {
    const source = readSource(ROUTE);
    expect(source).not.toContain("keepPreviousData");
    expect(source).not.toContain("placeholderData");
  });

  it("routes every render decision through resolveHomeSummaryView", () => {
    const source = readSource(ROUTE);
    expect(source).toContain("resolveHomeSummaryView(");
    expect(source).toContain('from "@/lib/home-summary-view"');
  });

  it("the segmented control is not gated behind the fetched summary", () => {
    // It must stay mounted (and reflect the tap immediately) whether the
    // query for the new range is loading, erroring, or done: it appears
    // before the first place that reads real numbers off `summary`.
    const source = readSource(ROUTE);
    const controlIdx = source.indexOf("<SegmentedControl");
    const firstSummaryReadIdx = source.indexOf("summary.finance.status");
    expect(controlIdx).toBeGreaterThan(-1);
    expect(firstSummaryReadIdx).toBeGreaterThan(-1);
    expect(controlIdx).toBeLessThan(firstSummaryReadIdx);
  });
});
