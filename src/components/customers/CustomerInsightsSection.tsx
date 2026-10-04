import { useTranslation } from "react-i18next";
import { Section, SectionRow, SectionRows } from "@/design-system";
import { fullTimestamp } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import {
  deliveryParts,
  insightMoney,
  outstandingLines,
  paymentParts,
  sourceParts,
  topProductLabel,
  type CountPart,
  type CustomerInsights,
} from "@/lib/customer-insights-view";
import type { Money } from "@/types";

const SOURCE_LABEL_KEY: Record<string, string> = {
  POS: "channel.pos",
  FACEBOOK: "channel.facebook",
  INSTAGRAM: "channel.instagram",
  TELEGRAM: "channel.telegram",
  MANUAL: "order.sourceManual",
};

/** One amount per line — currencies are never summed, so they are never joined either. */
function MoneyStack({ lines }: { lines: Money[] }) {
  return (
    <span className="flex flex-col items-end">
      {lines.map((m) => (
        <span key={m.currency} className="tnum">
          {formatMoney(m)}
        </span>
      ))}
    </span>
  );
}

/**
 * Customer Intelligence V1 — a compact, factual summary for Customer Detail.
 * Every number is the server's (src/server/customers/insights.ts); this only
 * lays it out. Statuses are always words, never colour alone. A section the
 * member may not see is left out rather than shown as zero.
 */
export function CustomerInsightsSection({
  insights,
  sensitiveVisible,
}: {
  insights: CustomerInsights;
  /** `customers.view_sensitive` as it stands now — see customerSensitiveVisible. */
  sensitiveVisible: boolean;
}) {
  const { t } = useTranslation();
  const { activity } = insights;

  if (!insights.hasPurchases) {
    return (
      <Section title={t("customerInsights.title")}>
        <p className="text-body text-text-primary">{t("customerInsights.noPurchases")}</p>
        <p className="text-body-sm mt-1 text-text-secondary">
          {t("customerInsights.noPurchasesBody")}
        </p>
        {activity.cancelledOrderCount > 0 ? (
          <SectionRows className="mt-3 border-t border-border-default pt-3">
            <SectionRow
              label={t("customerInsights.cancelled")}
              value={t("customerInsights.orderCount", { count: activity.cancelledOrderCount })}
            />
          </SectionRows>
        ) : null}
      </Section>
    );
  }

  const money = insightMoney(insights, sensitiveVisible);
  const owed = money.kind === "values" ? outstandingLines(money.byCurrency) : [];
  const delivery = deliveryParts(insights);
  const payments = paymentParts(insights);
  const sources = sourceParts(insights);

  const joinParts = <K extends string>(list: CountPart<K>[], labelOf: (key: K) => string) =>
    list.length === 0
      ? t("customerInsights.none")
      : list
          .map((part) =>
            t("customerInsights.part", { label: labelOf(part.key), count: part.count }),
          )
          .join(", ");

  return (
    <Section title={t("customerInsights.title")}>
      <SectionRows>
        <SectionRow
          label={t("customerInsights.orders")}
          value={t("customerInsights.ordersValue", {
            count: activity.orderCount,
            completed: activity.completedOrderCount,
            open: activity.openOrderCount,
          })}
        />
        {activity.firstOrderAt ? (
          <SectionRow
            label={t("customerInsights.firstOrder")}
            value={fullTimestamp(activity.firstOrderAt)}
          />
        ) : null}
        {activity.lastOrderProducts.length > 0 ? (
          <SectionRow
            label={t("customerInsights.lastBought")}
            value={activity.lastOrderProducts.join(", ")}
          />
        ) : null}
        {owed.length > 0 ? (
          <SectionRow
            label={t("customerInsights.outstanding")}
            value={<MoneyStack lines={owed} />}
          />
        ) : null}
        {activity.refundedOrderCount > 0 ? (
          <SectionRow
            label={t("customerInsights.refunds")}
            value={t("customerInsights.orderCount", { count: activity.refundedOrderCount })}
          />
        ) : null}
        {activity.cancelledOrderCount > 0 ? (
          <SectionRow
            label={t("customerInsights.cancelled")}
            value={t("customerInsights.orderCount", { count: activity.cancelledOrderCount })}
          />
        ) : null}
        {delivery && insights.delivery.status === "available" ? (
          <SectionRow
            label={t("customerInsights.deliveries")}
            value={
              <span className="flex flex-col items-end">
                <span>{joinParts(delivery, (key) => t(`status.${key}`))}</span>
                {insights.delivery.data.failedAttemptCount > 0 ? (
                  <span className="text-body-sm text-text-secondary">
                    {t("customerInsights.failedAttempts", {
                      count: insights.delivery.data.failedAttemptCount,
                    })}
                  </span>
                ) : null}
              </span>
            }
          />
        ) : null}
        {insights.returns.status === "available" && insights.returns.data.returnCount > 0 ? (
          <SectionRow
            label={t("customerInsights.returns")}
            value={t("customerInsights.returnsValue", {
              count: insights.returns.data.returnCount,
              completed: insights.returns.data.completedReturnCount,
            })}
          />
        ) : null}
        {payments ? (
          <SectionRow
            label={t("customerInsights.paymentMethods")}
            value={joinParts(payments, (key) => t(`payments.method.${key}`))}
          />
        ) : null}
        <SectionRow
          label={t("customerInsights.orderedVia")}
          value={joinParts(sources, (key) => t(SOURCE_LABEL_KEY[key] ?? "status.unknown"))}
        />
      </SectionRows>

      {insights.topProducts.length > 0 ? (
        <div className="mt-3 border-t border-border-default pt-3">
          <h3 className="text-label text-text-secondary">{t("customerInsights.topProducts")}</h3>
          <ol className="mt-1 divide-y divide-border-default">
            {insights.topProducts.map((product) => (
              <li
                key={product.productId}
                className="flex min-w-0 items-start justify-between gap-3 py-2 last:pb-0"
              >
                <span className="text-body-sm min-w-0 break-words text-text-primary">
                  {topProductLabel(product)}
                </span>
                <span className="text-body-sm tnum shrink-0 text-text-secondary">
                  {t("customerInsights.units", { count: product.units })}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <p className="text-caption mt-3 text-text-secondary">{t("customerInsights.footnote")}</p>
    </Section>
  );
}

export { MoneyStack };
