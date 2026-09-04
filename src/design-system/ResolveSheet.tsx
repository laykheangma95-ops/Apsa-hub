import { useNavigate } from "@tanstack/react-router";
import { CreditCard, ScanLine, Search, Truck, UserSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import { BottomSheet } from "./BottomSheet";
import { cn } from "@/lib/utils";

interface ResolveSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ResolveAction = {
  id: string;
  icon: LucideIcon;
  labelKey: string;
  /** Existing destination, or undefined while the action is not built yet. */
  to?: "/app/inbox" | "/app/pos";
};

const ACTIONS: ResolveAction[] = [
  { id: "scan", icon: ScanLine, labelKey: "resolve.scanBarcode" },
  { id: "customer", icon: UserSearch, labelKey: "resolve.findCustomer", to: "/app/inbox" },
  { id: "order", icon: Search, labelKey: "resolve.findOrder", to: "/app/pos" },
  { id: "payment", icon: CreditCard, labelKey: "resolve.checkPayment" },
  { id: "delivery", icon: Truck, labelKey: "resolve.trackDelivery" },
];

export function ResolveSheet({ open, onOpenChange }: ResolveSheetProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("resolve.title")}
      snap="half"
      className="glass-panel rounded-t-3xl"
    >
      <p className="text-body-sm -mt-1 mb-3 text-text-secondary">{t("resolve.subtitle")}</p>
      <ul className="stack-group">
        {ACTIONS.map((action) => {
          const Icon = action.icon;
          const available = Boolean(action.to);
          return (
            <li key={action.id}>
              <button
                type="button"
                disabled={!available}
                aria-disabled={!available}
                onClick={() => {
                  if (!action.to) return;
                  onOpenChange(false);
                  void navigate({ to: action.to });
                }}
                className={cn(
                  "press-tactile tap-target flex w-full items-center gap-3 rounded-2xl border border-border-default bg-surface-primary px-4 py-3 text-left",
                  !available && "opacity-60",
                )}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-action-primary-soft text-action-primary">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-body block truncate text-text-primary">
                    {t(action.labelKey)}
                  </span>
                  {!available ? (
                    <span className="text-caption block text-text-muted">
                      {t("resolve.comingSoon")}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </BottomSheet>
  );
}
