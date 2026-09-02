import type { HomeSummary, MetricRange } from "@/types";
import { usd } from "@/lib/money";

const series = (values: number[]) =>
  values.map((value, index) => ({ label: `p${index + 1}`, value }));

export const homeSummaries: Record<MetricRange, HomeSummary> = {
  today: {
    greetingName: "សុខជា",
    revenue: usd(1298050),
    revenueDeltaPercent: 16.5,
    revenueSeries: series([320, 410, 380, 520, 610, 580, 760]),
    attention: [
      { id: "unread_conversations", count: 7, tone: "info" },
      { id: "awaiting_payment", count: 3, tone: "warning" },
      { id: "awaiting_delivery", count: 5, tone: "info" },
      { id: "low_stock", count: 2, tone: "danger" },
    ],
    metrics: [
      { id: "orders", value: "38", deltaPercent: 12.4, series: series([4, 6, 5, 8, 7, 9, 12]) },
      { id: "new_customers", value: "9", deltaPercent: 4.2, series: series([1, 2, 1, 3, 2, 3, 4]) },
      {
        id: "avg_order",
        value: "$18.40",
        deltaPercent: -2.1,
        series: series([19, 18, 20, 17, 18, 18, 17]),
      },
      {
        id: "messages",
        value: "126",
        deltaPercent: 21.8,
        series: series([12, 18, 15, 24, 22, 19, 26]),
      },
    ],
  },
  week: {
    greetingName: "សុខជា",
    revenue: usd(6412075),
    revenueDeltaPercent: 9.8,
    revenueSeries: series([820, 910, 1080, 1220, 1010, 1340, 1450]),
    attention: [
      { id: "unread_conversations", count: 7, tone: "info" },
      { id: "awaiting_payment", count: 3, tone: "warning" },
      { id: "awaiting_delivery", count: 5, tone: "info" },
      { id: "low_stock", count: 2, tone: "danger" },
    ],
    metrics: [
      { id: "orders", value: "214", deltaPercent: 8.1, series: series([28, 33, 30, 38, 35, 24, 26]) },
      {
        id: "new_customers",
        value: "41",
        deltaPercent: 11.5,
        series: series([5, 7, 6, 8, 5, 4, 6]),
      },
      {
        id: "avg_order",
        value: "$19.10",
        deltaPercent: 1.4,
        series: series([18, 19, 19, 20, 19, 19, 20]),
      },
      {
        id: "messages",
        value: "742",
        deltaPercent: 6.7,
        series: series([98, 112, 104, 121, 96, 102, 109]),
      },
    ],
  },
  month: {
    greetingName: "សុខជា",
    revenue: usd(24980420),
    revenueDeltaPercent: 22.3,
    revenueSeries: series([3200, 3600, 4100, 3900, 4400, 4800, 5200]),
    attention: [
      { id: "unread_conversations", count: 7, tone: "info" },
      { id: "awaiting_payment", count: 3, tone: "warning" },
      { id: "awaiting_delivery", count: 5, tone: "info" },
      { id: "low_stock", count: 2, tone: "danger" },
    ],
    metrics: [
      {
        id: "orders",
        value: "861",
        deltaPercent: 18.9,
        series: series([110, 128, 134, 121, 145, 112, 111]),
      },
      {
        id: "new_customers",
        value: "163",
        deltaPercent: 14.2,
        series: series([20, 24, 26, 22, 25, 23, 23]),
      },
      {
        id: "avg_order",
        value: "$18.90",
        deltaPercent: 0.6,
        series: series([18, 19, 18, 19, 19, 19, 19]),
      },
      {
        id: "messages",
        value: "3,104",
        deltaPercent: 9.1,
        series: series([420, 448, 460, 431, 470, 442, 433]),
      },
    ],
  },
};
