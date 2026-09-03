import {
  AlertTriangle,
  Ban,
  Check,
  CheckCheck,
  Clock,
  CornerUpLeft,
  Mail,
  MailOpen,
  Package,
  PackageCheck,
  PackageX,
  RotateCcw,
  ShoppingBag,
  Truck,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { StatusKey } from "@/types";

type Tone = "info" | "success" | "warning" | "danger" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  info: "bg-status-info-soft text-status-info-text",
  success: "bg-status-success-soft text-status-success-text",
  warning: "bg-status-warning-soft text-status-warning-text",
  danger: "bg-status-danger-soft text-status-danger-text",
  neutral: "bg-surface-secondary text-text-secondary",
};

const MAP: Record<StatusKey, { tone: Tone; icon: LucideIcon }> = {
  unread: { tone: "info", icon: Mail },
  needs_reply: { tone: "warning", icon: CornerUpLeft },
  follow_up: { tone: "warning", icon: Clock },
  waiting_customer: { tone: "neutral", icon: MailOpen },
  order_created: { tone: "success", icon: ShoppingBag },
  closed: { tone: "neutral", icon: Check },
  pending_payment: { tone: "warning", icon: Wallet },
  partially_paid: { tone: "warning", icon: Wallet },
  paid: { tone: "success", icon: CheckCheck },
  failed: { tone: "danger", icon: X },
  refunded: { tone: "neutral", icon: RotateCcw },
  partially_refunded: { tone: "neutral", icon: RotateCcw },
  requested: { tone: "neutral", icon: Clock },
  accepted: { tone: "info", icon: Check },
  picked_up: { tone: "info", icon: Package },
  confirmed: { tone: "info", icon: Check },
  packing: { tone: "info", icon: Package },
  ready: { tone: "info", icon: PackageCheck },
  in_transit: { tone: "info", icon: Truck },
  delivered: { tone: "success", icon: PackageCheck },
  cancelled: { tone: "danger", icon: Ban },
  returned: { tone: "warning", icon: PackageX },
  low_stock: { tone: "warning", icon: AlertTriangle },
  out_of_stock: { tone: "danger", icon: PackageX },
  active: { tone: "success", icon: Check },
  invited: { tone: "warning", icon: Clock },
};

interface StatusChipProps {
  status: StatusKey;
  className?: string;
  size?: "sm" | "md";
}

/** Status is never colour alone — every chip carries an icon and a label. */
export function StatusChip({ status, className, size = "sm" }: StatusChipProps) {
  const { t } = useTranslation();
  const { tone, icon: Icon } = MAP[status];

  return (
    <span
      className={cn(
        "text-label inline-flex max-w-full items-center gap-1.5 rounded-full",
        size === "md" ? "px-2.5 py-1" : "px-2 py-0.5",
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="chip-text">{t(`status.${status}`)}</span>
    </span>
  );
}
