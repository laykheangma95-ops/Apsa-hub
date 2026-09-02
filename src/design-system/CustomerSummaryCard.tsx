import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { initials, fullTimestamp } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { ChannelBadge } from "./ChannelBadge";
import type { CompanionColor, Customer } from "@/types";

const COMPANION_VAR: Record<CompanionColor, string> = {
  nilo: "var(--companion-nilo)",
  minto: "var(--companion-minto)",
  vela: "var(--companion-vela)",
  suri: "var(--companion-suri)",
  luma: "var(--companion-luma)",
};

interface CustomerSummaryCardProps {
  customer: Customer;
  displayName: string;
  onViewProfile?: () => void;
  className?: string;
}

export function CustomerSummaryCard({
  customer,
  displayName,
  onViewProfile,
  className,
}: CustomerSummaryCardProps) {
  const { t } = useTranslation();

  return (
    <section
      className={cn(
        "rounded-2xl border border-border-default bg-surface-primary p-4",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="text-h3 flex size-12 shrink-0 items-center justify-center rounded-full text-text-inverse"
          style={{ backgroundColor: COMPANION_VAR[customer.companion] }}
        >
          {initials(displayName)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-h3 text-text-primary">{displayName}</h3>
          <p className="text-body-sm tnum text-text-secondary">{customer.phone}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {customer.identities.map((identity) => (
              <ChannelBadge key={identity.channel} channel={identity.channel} withLabel />
            ))}
          </div>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3">
        <div>
          <dt className="text-caption text-text-muted">{t("customer.orders")}</dt>
          <dd className="text-financial text-text-primary">{customer.orderCount}</dd>
        </div>
        <div>
          <dt className="text-caption text-text-muted">{t("customer.spend")}</dt>
          <dd className="text-financial text-text-primary">{formatMoney(customer.lifetimeSpend)}</dd>
        </div>
        <div>
          <dt className="text-caption text-text-muted">{t("customer.lastPurchase")}</dt>
          <dd className="text-data text-text-primary">
            {customer.lastPurchaseAt ? fullTimestamp(customer.lastPurchaseAt) : "—"}
          </dd>
        </div>
      </dl>

      <p className="text-body-sm mt-3 text-text-secondary">
        {customer.note ?? t("customer.noNote")}
      </p>

      {customer.tags.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {customer.tags.map((tag) => (
            <span
              key={tag}
              className="text-caption chip-text rounded-full bg-surface-secondary px-2 py-0.5 text-text-secondary"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {onViewProfile ? (
        <button
          type="button"
          onClick={onViewProfile}
          className="tap-target text-label mt-3 inline-flex items-center text-action-primary"
        >
          {t("customer.viewProfile")}
        </button>
      ) : null}
    </section>
  );
}
