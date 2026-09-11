import { FileText, PackagePlus, ShoppingBag, Wallet, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export type QuickActionId = "receivePayment" | "newOrder" | "addProduct" | "sendInvoice";

const ICONS: Record<QuickActionId, LucideIcon> = {
  receivePayment: Wallet,
  newOrder: ShoppingBag,
  addProduct: PackagePlus,
  sendInvoice: FileText,
};

/** Fixed display order. Exported so callers can ask what the grid will render. */
export const QUICK_ACTION_IDS: readonly QuickActionId[] = [
  "receivePayment",
  "newOrder",
  "addProduct",
  "sendInvoice",
];

/** The ids that survive an availability map — the grid renders exactly these. */
export function visibleQuickActions(
  available: Partial<Record<QuickActionId, boolean>> | undefined,
): readonly QuickActionId[] {
  return QUICK_ACTION_IDS.filter((id) => available?.[id] !== false);
}

interface QuickActionGridProps {
  onAction?: (id: QuickActionId) => void;
  /**
   * Which starting points this member can actually use. An id mapped to false
   * is left out entirely — a command centre that offers work the server will
   * refuse is worse than a shorter one. Omitted ids are shown.
   */
  available?: Partial<Record<QuickActionId, boolean>> | undefined;
  className?: string;
}

/**
 * Four starting points, two per row.
 *
 * The old 4-across grid gave each tile 68px on a 320px phone; every Khmer
 * label — which cannot hyphenate or truncate cleanly — clipped. Two columns
 * with a leading icon give the label a real line to sit on in both languages.
 */
export function QuickActionGrid({ onAction, available, className }: QuickActionGridProps) {
  const { t } = useTranslation();
  const visible = visibleQuickActions(available);

  if (visible.length === 0) return null;

  return (
    <div className={cn("grid grid-cols-2 gap-2", className)}>
      {visible.map((id) => {
        const Icon = ICONS[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() => onAction?.(id)}
            className="press tap-target flex items-center gap-2.5 rounded-2xl border border-border-default bg-surface-primary px-3 py-2.5 text-left transition-colors hover:bg-surface-secondary"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-action-primary-soft text-action-primary">
              <Icon className="size-[18px]" aria-hidden />
            </span>
            <span className="text-label chip-text min-w-0 text-text-primary">
              {t(`home.actions.${id}`)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
