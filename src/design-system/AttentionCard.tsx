import {
  AlertTriangle,
  ChevronRight,
  MessageSquare,
  Truck,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { AttentionItem } from "@/types";

const ICONS: Record<AttentionItem["id"], LucideIcon> = {
  unread_conversations: MessageSquare,
  awaiting_payment: Wallet,
  payments_needing_review: Wallet,
  awaiting_delivery: Truck,
  low_stock: AlertTriangle,
  orders_needing_action: AlertTriangle,
};

const TONE: Record<AttentionItem["tone"], string> = {
  info: "bg-status-info-soft text-status-info-text",
  warning: "bg-status-warning-soft text-status-warning-text",
  danger: "bg-status-danger-soft text-status-danger-text",
};

interface AttentionCardProps {
  item: AttentionItem;
  onClick?: (() => void) | undefined;
  className?: string;
}

/**
 * One thing waiting on the merchant, in one row: how many, what, and the way
 * to go deal with it. The count leads because that is what a merchant scans
 * for; the chevron only appears when the row actually goes somewhere, so a
 * placeholder never pretends to be a link.
 */
export function AttentionCard({ item, onClick, className }: AttentionCardProps) {
  const { t } = useTranslation();
  const Icon = ICONS[item.id];
  const label = t(`home.attentionItems.${item.id}`);

  const body = (
    <>
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-2xl",
          TONE[item.tone],
        )}
      >
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="text-h2 tnum shrink-0 text-text-primary">{item.count}</span>
        <span className="text-body-sm min-w-0 flex-1 text-text-secondary">{label}</span>
      </span>
      {onClick ? <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden /> : null}
    </>
  );

  const shared =
    "flex w-full items-center gap-3 rounded-2xl border border-border-default bg-surface-primary px-3 py-2.5 text-left";

  if (!onClick) {
    return <div className={cn(shared, "tap-target", className)}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("home.attentionAction", { count: item.count, label })}
      className={cn(shared, "press tap-target hover:bg-surface-secondary", className)}
    >
      {body}
    </button>
  );
}
