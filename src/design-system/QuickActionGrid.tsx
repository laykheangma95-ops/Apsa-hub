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

const ORDER: QuickActionId[] = ["receivePayment", "newOrder", "addProduct", "sendInvoice"];

interface QuickActionGridProps {
  onAction?: (id: QuickActionId) => void;
  className?: string;
}

export function QuickActionGrid({ onAction, className }: QuickActionGridProps) {
  const { t } = useTranslation();

  return (
    <div className={cn("grid grid-cols-4 gap-2", className)}>
      {ORDER.map((id) => {
        const Icon = ICONS[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() => onAction?.(id)}
            className="tap-target flex flex-col items-center gap-1.5 rounded-2xl border border-border-default bg-surface-primary px-1 py-3 text-center transition-colors hover:bg-surface-secondary"
          >
            <span className="flex size-9 items-center justify-center rounded-xl bg-action-primary-soft text-action-primary">
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="text-caption chip-text text-text-secondary">
              {t(`home.actions.${id}`)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
