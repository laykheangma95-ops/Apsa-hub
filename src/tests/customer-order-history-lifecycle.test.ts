/**
 * Customer 360 order history must show the order LIFECYCLE, not only payment
 * and fulfilment — otherwise a cancelled order reads as merely "Unpaid · Not
 * yet fulfilled" and a draft reads like a confirmed sale.
 *
 * Behavioral: the pure fact list, and the rendered row through the real
 * StatusBadge / StatusChip components with English copy.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { CustomerOrderStatuses } from "@/components/customers/CustomerOrderStatuses";
import { customerOrderStatusFacts } from "@/lib/customers-view";
import i18n from "@/lib/i18n";
import en from "../locales/en.json";
import type { Order } from "@/types";

await i18n.changeLanguage("en");
const S = en.status as Record<string, string>;

type Row = Pick<Order, "lifecycleStatus" | "paymentStatus" | "fulfillmentStatus" | "refundStatus">;

function text(order: Row): string {
  return renderToStaticMarkup(createElement(CustomerOrderStatuses, { order }))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("customerOrderStatusFacts — axes stay separate, lifecycle first", () => {
  it("draft shows Draft before payment and fulfilment", () => {
    expect(
      customerOrderStatusFacts({
        lifecycleStatus: "draft",
        paymentStatus: "unpaid",
        fulfillmentStatus: "unfulfilled",
        refundStatus: "none",
      }),
    ).toEqual([
      { axis: "lifecycle", status: "draft" },
      { axis: "payment", status: "unpaid" },
      { axis: "fulfillment", status: "unfulfilled" },
    ]);
  });

  it("confirmed and completed keep their own lifecycle fact", () => {
    for (const lifecycleStatus of ["confirmed", "completed"] as const) {
      const facts = customerOrderStatusFacts({
        lifecycleStatus,
        paymentStatus: "paid",
        fulfillmentStatus: "fulfilled",
      });
      expect(facts[0]).toEqual({ axis: "lifecycle", status: lifecycleStatus });
      expect(facts).toContainEqual({ axis: "payment", status: "paid" });
      expect(facts).toContainEqual({ axis: "fulfillment", status: "fulfilled" });
    }
  });

  it("refund is its own axis — payment stays paid, lifecycle is untouched", () => {
    const full = customerOrderStatusFacts({
      lifecycleStatus: "completed",
      paymentStatus: "paid",
      fulfillmentStatus: "fulfilled",
      refundStatus: "full",
    });
    expect(full).toEqual([
      { axis: "lifecycle", status: "completed" },
      { axis: "payment", status: "paid" },
      { axis: "refund", status: "refunded" },
      { axis: "fulfillment", status: "fulfilled" },
    ]);
    const partial = customerOrderStatusFacts({
      lifecycleStatus: "confirmed",
      paymentStatus: "paid",
      fulfillmentStatus: "unfulfilled",
      refundStatus: "partial",
    });
    expect(partial).toContainEqual({ axis: "refund", status: "partially_refunded" });
    expect(partial[0]).toEqual({ axis: "lifecycle", status: "confirmed" });
  });

  it("fulfilment moves independently of lifecycle", () => {
    const facts = customerOrderStatusFacts({
      lifecycleStatus: "confirmed",
      paymentStatus: "unpaid",
      fulfillmentStatus: "processing",
    });
    expect(facts).toContainEqual({ axis: "lifecycle", status: "confirmed" });
    expect(facts).toContainEqual({ axis: "fulfillment", status: "processing" });
  });
});

describe("rendered history row", () => {
  it("a cancelled order visibly says Cancelled — never merely unpaid/unfulfilled", () => {
    const rendered = text({
      lifecycleStatus: "cancelled",
      paymentStatus: "unpaid",
      fulfillmentStatus: "unfulfilled",
      refundStatus: "none",
    });
    expect(rendered).toContain(S["cancelled"]!);
    // Lifecycle is read first.
    expect(rendered.indexOf(S["cancelled"]!)).toBeLessThan(rendered.indexOf(S["unpaid"]!));
    expect(rendered).toContain(S["unfulfilled"]!);
  });

  it("a draft order visibly says Draft", () => {
    const rendered = text({
      lifecycleStatus: "draft",
      paymentStatus: "unpaid",
      fulfillmentStatus: "unfulfilled",
    });
    expect(rendered).toContain(S["draft"]!);
    expect(rendered.indexOf(S["draft"]!)).toBeLessThan(rendered.indexOf(S["unpaid"]!));
  });

  it("confirmed and completed render their lifecycle label", () => {
    expect(
      text({
        lifecycleStatus: "confirmed",
        paymentStatus: "unpaid",
        fulfillmentStatus: "unfulfilled",
      }),
    ).toContain(S["confirmed"]!);
    expect(
      text({ lifecycleStatus: "completed", paymentStatus: "paid", fulfillmentStatus: "fulfilled" }),
    ).toContain(S["completed"]!);
  });

  it("a refunded completed order shows Completed, Paid and Refunded as three facts", () => {
    const rendered = text({
      lifecycleStatus: "completed",
      paymentStatus: "paid",
      fulfillmentStatus: "fulfilled",
      refundStatus: "full",
    });
    for (const label of [S["completed"]!, S["paid"]!, S["refunded"]!, S["fulfilled"]!]) {
      expect(rendered).toContain(label);
    }
  });

  it("Customer 360 renders history statuses through CustomerOrderStatuses", () => {
    const route = readFileSync("src/routes/app.customers.$id.tsx", "utf8");
    expect(route).toContain("<CustomerOrderStatuses order={order} />");
    // The old two-chip row (payment + fulfilment only) is gone.
    expect(route).not.toContain("<StatusChip status={order.paymentStatus} />");
  });
});
