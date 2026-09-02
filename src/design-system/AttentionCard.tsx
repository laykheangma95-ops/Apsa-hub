import { AlertTriangle, ChevronRight, MessageSquare, Truck, Wallet, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { AttentionItem } from "@/types";

const ICONS: Record<AttentionItem["id"], LucideIcon> = {
  unread_conversations: MessageSquare,
  awaiting_payment: Wallet,
  awaiting_delivery: Truck,
  low_stock: AlertTriangle,
};

const TONE: Record<AttentionItem["tone"], string> = {
  info: "bg-status-info-soft text-status-info-text",
  warning: "bg-status-warning-soft text-status-warning-text",
  danger: "bg-status-danger-soft text-status-danger-text",
};

interface AttentionCardProps {
  item: AttentionItem;
  onClick?: () => void;
  className?: string;
}

export function AttentionCard({ item, onClick, className }: AttentionCardProps) {
  const { t } = useTranslation();
  const Icon = ICONS[item.id];

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "tap-target flex w-full items-center gap-3 rounded-2xl border border-border-default bg-surface-primary px-3 py-3 text-left transition-colors hover:bg-surface-secondary",
        className,
      )}
    >
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", TONE[item.tone])}>
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-financial block text-text-primary">{item.count}</span>
        <span className="text-body-sm block text-text-secondary">
          {t(`home.attentionItems.${item.id}`)}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden />
    </button>
  );
}
