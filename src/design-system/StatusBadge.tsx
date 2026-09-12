import type { CSSProperties } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  Ban,
  Calendar,
  Check,
  CheckCheck,
  CircleCheck,
  CirclePause,
  CircleX,
  Clock,
  CloudUpload,
  Cog,
  CornerUpLeft,
  CreditCard,
  Flag,
  Info,
  Link2,
  Mail,
  MailOpen,
  MapPin,
  MessageSquare,
  Package,
  PackageCheck,
  PackageOpen,
  PackageX,
  RotateCcw,
  ShoppingBag,
  Sparkles,
  Truck,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { StatusKey } from "@/types";

/**
 * StatusBadge tones. The five semantic tones predate the badge system; the
 * extended set comes from the APSA Status System reference and is registered
 * as design tokens in styles.css (--status-{tone} / -soft / -text).
 */
export type StatusBadgeTone =
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "neutral"
  | "cyan"
  | "teal"
  | "orange"
  | "purple"
  | "violet"
  | "pink"
  | "indigo";

/**
 * Every status StatusBadge can render: the full StatusKey vocabulary plus the
 * badge-specific states from the status-system reference (sync, connectivity,
 * review flow, scheduling, archive).
 */
export type StatusBadgeKey =
  | StatusKey
  | "synced"
  | "connected"
  | "new_message"
  | "ai_suggested"
  | "in_review"
  | "approved"
  | "cod_pending"
  | "scheduled"
  | "in_delivery"
  | "archived"
  | "paused";

const META: Record<StatusBadgeKey, { tone: StatusBadgeTone; icon: LucideIcon }> = {
  // ── Status system reference ────────────────────────────────────────────────
  synced: { tone: "cyan", icon: CloudUpload },
  connected: { tone: "info", icon: Link2 },
  new_message: { tone: "purple", icon: MessageSquare },
  needs_reply: { tone: "pink", icon: CornerUpLeft },
  ai_suggested: { tone: "violet", icon: Sparkles },
  in_review: { tone: "info", icon: Info },
  approved: { tone: "success", icon: CircleCheck },
  pending: { tone: "orange", icon: AlertTriangle },
  pending_payment: { tone: "warning", icon: Wallet },
  paid: { tone: "success", icon: CreditCard },
  cod_pending: { tone: "orange", icon: Wallet },
  processing: { tone: "indigo", icon: Cog },
  scheduled: { tone: "purple", icon: Calendar },
  in_delivery: { tone: "info", icon: Truck },
  delivered: { tone: "success", icon: MapPin },
  completed: { tone: "teal", icon: Flag },
  refunded: { tone: "pink", icon: RotateCcw },
  cancelled: { tone: "danger", icon: CircleX },
  failed: { tone: "danger", icon: AlertCircle },
  archived: { tone: "neutral", icon: Archive },
  low_stock: { tone: "danger", icon: PackageOpen },
  paused: { tone: "info", icon: CirclePause },
  // ── Inbox ──────────────────────────────────────────────────────────────────
  unread: { tone: "info", icon: Mail },
  follow_up: { tone: "warning", icon: Clock },
  waiting_customer: { tone: "neutral", icon: MailOpen },
  order_created: { tone: "success", icon: ShoppingBag },
  closed: { tone: "neutral", icon: Check },
  // ── Payments ───────────────────────────────────────────────────────────────
  partially_paid: { tone: "warning", icon: Wallet },
  partially_refunded: { tone: "neutral", icon: RotateCcw },
  unpaid: { tone: "warning", icon: Wallet },
  // ── Delivery ───────────────────────────────────────────────────────────────
  requested: { tone: "neutral", icon: Clock },
  accepted: { tone: "info", icon: Check },
  picked_up: { tone: "info", icon: Package },
  confirmed: { tone: "info", icon: Check },
  packing: { tone: "info", icon: Package },
  ready: { tone: "info", icon: PackageCheck },
  in_transit: { tone: "info", icon: Truck },
  returned: { tone: "warning", icon: PackageX },
  preparing: { tone: "info", icon: Package },
  // ── Inventory / team ───────────────────────────────────────────────────────
  out_of_stock: { tone: "danger", icon: PackageX },
  active: { tone: "success", icon: Check },
  invited: { tone: "warning", icon: Clock },
  suspended: { tone: "neutral", icon: Ban },
  // ── Production order lifecycle ─────────────────────────────────────────────
  draft: { tone: "neutral", icon: Clock },
  unfulfilled: { tone: "neutral", icon: Package },
  fulfilled: { tone: "success", icon: PackageCheck },
};

/** All renderable keys — kept in one place so tests can iterate the full set. */
export const STATUS_BADGE_KEYS = Object.keys(META) as StatusBadgeKey[];

const badgeVariants = cva("inline-flex max-w-full items-center rounded-full text-label", {
  variants: {
    size: {
      sm: "gap-1.5 px-2 py-0.5",
      md: "gap-1.5 px-2.5 py-1",
      lg: "gap-2 px-3 py-1.5",
    },
    variant: {
      glass: "badge-glass",
      flat: "badge-flat",
    },
  },
  defaultVariants: {
    size: "md",
    variant: "glass",
  },
});

const ICON_CLASS: Record<NonNullable<VariantProps<typeof badgeVariants>["size"]>, string> = {
  sm: "size-3.5 shrink-0",
  md: "size-3.5 shrink-0",
  lg: "size-4 shrink-0",
};

export interface StatusBadgeProps extends VariantProps<typeof badgeVariants> {
  status: StatusBadgeKey;
  className?: string;
}

/**
 * The APSA status badge: a token-driven pill in the liquid-glass style.
 * Tone, surface and text colour always come from the --status-{tone} token
 * trio — never a per-screen literal — and a badge is never colour alone:
 * every state ships its icon alongside the translated label.
 */
export function StatusBadge({
  status,
  size = "md",
  variant = "glass",
  className,
}: StatusBadgeProps) {
  const { t } = useTranslation();
  const { tone, icon: Icon } = META[status];
  const label = t(`status.${status}`);

  const toneVars = {
    "--badge-tone": `var(--status-${tone})`,
    "--badge-soft": `var(--status-${tone}-soft)`,
    "--badge-text": `var(--status-${tone}-text)`,
  } as CSSProperties;

  return (
    <span className={cn(badgeVariants({ size, variant }), className)} style={toneVars}>
      <Icon
        className={ICON_CLASS[size ?? "md"]}
        style={{ color: "var(--badge-tone)" }}
        aria-hidden
      />
      <span className="chip-text">{label}</span>
    </span>
  );
}
