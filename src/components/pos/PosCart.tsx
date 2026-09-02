import { Trash2, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QuantityStepper } from "@/design-system";
import { PosNotice } from "@/components/pos/PosNotice";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { formatMoney, usdToKhr } from "@/lib/money";
import type { DiscountMode } from "@/lib/order-draft";
import { lineTotal, type CartDiscountInput, type CartLine, type CartTotals } from "@/lib/pos-cart";
import { cn } from "@/lib/utils";
import type { Customer } from "@/types";

interface PosCartProps {
  lines: CartLine[];
  totals: CartTotals;
  discount: CartDiscountInput;
  onDiscountChange: (value: CartDiscountInput) => void;
  approvalRequired: boolean;
  customer: Customer | null;
  onPickCustomer: () => void;
  onClearCustomer: () => void;
  onQuantity: (key: string, quantity: number) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  onCheckout: () => void;
  offline: boolean;
  className?: string;
}

export function PosCart({
  lines,
  totals,
  discount,
  onDiscountChange,
  approvalRequired,
  customer,
  onPickCustomer,
  onClearCustomer,
  onQuantity,
  onRemove,
  onClear,
  onCheckout,
  offline,
  className,
}: PosCartProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [confirmClear, setConfirmClear] = useState(false);

  if (lines.length === 0) {
    return (
      <div className={cn("flex flex-1 flex-col", className)}>
        <PosNotice title={t("pos.cart.empty.title")} body={t("pos.cart.empty.body")} />
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="divide-y divide-border-default">
          {lines.map((line) => (
            <li key={line.key} className="py-3">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                <div className="min-w-0">
                  <p className="text-body truncate text-text-primary">
                    {localName(line, language)}
                  </p>
                  <p className="text-caption text-text-secondary">
                    {line.variant ? `${line.variant} · ` : ""}
                    {formatMoney(line.unitPrice)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-financial text-text-primary">
                    {formatMoney(lineTotal(line))}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemove(line.key)}
                    aria-label={t("pos.cart.remove", { name: localName(line, language) })}
                    className="tap-target flex items-center justify-center rounded-lg text-text-secondary transition-colors hover:text-status-danger-text"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </div>
              </div>
              <div className="mt-2">
                <QuantityStepper
                  value={line.quantity}
                  onChange={(q) => onQuantity(line.key, q)}
                  max={Math.max(1, line.stock)}
                />
              </div>
            </li>
          ))}
        </ul>

        <div className="py-3">
          {confirmClear ? (
            <div
              role="alertdialog"
              aria-label={t("pos.cart.clearConfirmTitle")}
              className="rounded-xl border border-border-default bg-surface-secondary p-3"
            >
              <p className="text-body-sm text-text-primary">{t("pos.cart.clearConfirmTitle")}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="outline"
                  className="tap-target flex-1"
                  onClick={() => setConfirmClear(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="outline"
                  className="tap-target flex-1 text-status-danger-text"
                  onClick={() => {
                    setConfirmClear(false);
                    onClear();
                  }}
                >
                  {t("pos.cart.clear")}
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => (totals.itemCount > 1 ? setConfirmClear(true) : onClear())}
              className="tap-target text-label text-text-secondary underline-offset-4 hover:underline"
            >
              {t("pos.cart.clear")}
            </button>
          )}
        </div>

        <div className="space-y-3 border-t border-border-default py-3">
          {customer ? (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-border-default bg-surface-primary p-3">
              <div className="min-w-0">
                <p className="text-body truncate text-text-primary">
                  {localName(customer, language)}
                </p>
                <p className="text-caption text-text-secondary">{customer.phone}</p>
              </div>
              <button
                type="button"
                onClick={onClearCustomer}
                aria-label={t("pos.customer.remove")}
                className="tap-target flex shrink-0 items-center justify-center rounded-lg text-text-secondary"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onPickCustomer}
              className="tap-target flex w-full items-center gap-2 rounded-xl border border-border-default bg-surface-primary px-3 text-left text-body text-text-primary"
            >
              <UserPlus className="size-4 shrink-0 text-text-secondary" aria-hidden />
              {t("pos.customer.add")}
              <span className="text-caption ml-auto text-text-muted">{t("pos.optional")}</span>
            </button>
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="text-label text-text-secondary">{t("pos.discount.label")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={discount.enabled}
              aria-label={t("pos.discount.label")}
              onClick={() => onDiscountChange({ ...discount, enabled: !discount.enabled })}
              className={cn(
                "tap-target flex w-14 items-center rounded-full px-1",
                discount.enabled ? "bg-action-primary" : "bg-surface-secondary",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-6 rounded-full bg-surface-primary shadow-sm transition-transform",
                  discount.enabled ? "translate-x-6" : "translate-x-0",
                )}
              />
            </button>
          </div>

          {discount.enabled ? (
            <div className="space-y-2">
              <div className="flex gap-2" role="group" aria-label={t("pos.discount.label")}>
                {(["amount", "percent"] as DiscountMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={discount.mode === mode}
                    onClick={() => onDiscountChange({ ...discount, mode, value: 0 })}
                    className={cn(
                      "tap-target flex-1 rounded-full border text-label transition-colors",
                      discount.mode === mode
                        ? "border-action-primary bg-action-primary text-text-on-action"
                        : "border-border-strong bg-surface-primary text-text-primary",
                    )}
                  >
                    <span className="chip-text">{t(`pos.discount.${mode}`)}</span>
                  </button>
                ))}
              </div>
              <Input
                inputMode="decimal"
                aria-label={t(`pos.discount.${discount.mode}`)}
                className="text-financial h-12"
                value={
                  discount.mode === "percent"
                    ? String(discount.value)
                    : (discount.value / 100).toFixed(2)
                }
                onChange={(e) => {
                  const parsed = Number.parseFloat(e.target.value.replace(/[^0-9.]/g, ""));
                  const safe = Number.isFinite(parsed) ? parsed : 0;
                  onDiscountChange({
                    ...discount,
                    value: discount.mode === "percent" ? Math.round(safe) : Math.round(safe * 100),
                  });
                }}
              />
              {approvalRequired ? (
                <p role="status" className="text-body-sm text-status-danger-text">
                  {t("pos.discount.approval")}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="sticky bottom-0 space-y-2 border-t border-border-default bg-surface-primary pt-3">
        <div className="flex items-center justify-between">
          <span className="text-label text-text-secondary">{t("pos.subtotal")}</span>
          <span className="text-body text-text-primary">{formatMoney(totals.subtotal)}</span>
        </div>
        {totals.discount.amount > 0 ? (
          <div className="flex items-center justify-between">
            <span className="text-label text-text-secondary">{t("pos.discount.label")}</span>
            <span className="text-body text-text-primary">-{formatMoney(totals.discount)}</span>
          </div>
        ) : null}
        <div className="flex items-end justify-between">
          <span className="text-label text-text-secondary">{t("pos.total")}</span>
          <span className="flex flex-col items-end">
            <span className="text-financial-lg text-text-primary">
              {formatMoney(totals.total)}
            </span>
            <span className="text-data text-text-muted">
              {t("money.approx", { value: formatMoney(usdToKhr(totals.total)) })}
            </span>
          </span>
        </div>
        <Button
          className="tap-target w-full"
          disabled={approvalRequired || offline || totals.itemCount === 0}
          onClick={onCheckout}
        >
          {t("pos.checkout")}
        </Button>
      </div>
    </div>
  );
}
