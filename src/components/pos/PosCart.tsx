import { Trash2, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QuantityStepper } from "@/design-system";
import { PosNotice } from "@/components/pos/PosNotice";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { approximateCounterpart, formatMoney } from "@/lib/money";
import type { DiscountMode } from "@/lib/order-draft";
import {
  checkoutBlock,
  lineTotal,
  type CartDiscountInput,
  type CartLine,
  type CartTotals,
  discountProblemKey,
} from "@/lib/pos-cart";
import { cn } from "@/lib/utils";
import type { Customer } from "@/types";

interface PosCartProps {
  lines: CartLine[];
  totals: CartTotals;
  discount: CartDiscountInput;
  onDiscountChange: (value: CartDiscountInput) => void;
  /**
   * The member holds orders.apply_discount — the permission createOrder itself
   * requires for any non-zero discount. Without it the control is not offered
   * (the server would refuse the sale); this decides what is SHOWN, never what
   * is ALLOWED.
   */
  canDiscount: boolean;
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
  canDiscount,
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
  const block = checkoutBlock(totals);
  // A fixed amount is typed in the cart's own currency; a mixed cart has none,
  // so the discount control waits until the cart is one currency again.
  const priced = totals.kind === "priced" ? totals : null;
  const amountCurrency = priced?.currency ?? null;
  const discountText =
    discount.mode === "amount" && discount.currency !== amountCurrency ? "" : discount.text;

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
              className="press tap-target flex w-full items-center gap-2 rounded-xl border border-border-default bg-surface-primary px-3 text-left text-body text-text-primary"
            >
              <UserPlus className="size-4 shrink-0 text-text-secondary" aria-hidden />
              {t("pos.customer.add")}
              <span className="text-caption ml-auto text-text-muted">{t("pos.optional")}</span>
            </button>
          )}

          {canDiscount && priced ? (
            <>
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
                        onClick={() =>
                          onDiscountChange({
                            ...discount,
                            mode,
                            text: "",
                            currency: amountCurrency,
                          })
                        }
                        className={cn(
                          "press tap-target flex-1 rounded-full border text-label transition-colors",
                          discount.mode === mode
                            ? "border-action-primary bg-action-primary text-text-on-action"
                            : "border-border-strong bg-surface-primary text-text-primary",
                        )}
                      >
                        <span className="chip-text">{t(`pos.discount.${mode}`)}</span>
                      </button>
                    ))}
                  </div>
                  <div className="relative">
                    <span
                      aria-hidden
                      className="text-financial pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-secondary"
                    >
                      {discount.mode === "percent" ? "%" : priced.currency === "USD" ? "$" : "៛"}
                    </span>
                    <Input
                      // Riel has no decimals and a percent is whole, so only a
                      // USD amount gets the decimal keypad.
                      inputMode={
                        discount.mode === "amount" && priced.currency === "USD"
                          ? "decimal"
                          : "numeric"
                      }
                      enterKeyHint="done"
                      autoComplete="off"
                      aria-label={
                        discount.mode === "percent"
                          ? t("pos.discount.percent")
                          : t("pos.discount.amountIn", { currency: priced.currency })
                      }
                      aria-invalid={priced.discountProblem ? true : undefined}
                      aria-describedby={priced.discountProblem ? "pos-discount-problem" : undefined}
                      placeholder={
                        discount.mode === "percent"
                          ? "10"
                          : priced.currency === "USD"
                            ? "0.00"
                            : "0"
                      }
                      className="text-financial h-12 pl-8"
                      value={discountText}
                      onChange={(e) =>
                        onDiscountChange({
                          ...discount,
                          text: e.target.value,
                          currency: amountCurrency,
                        })
                      }
                    />
                  </div>
                  {priced.discountProblem ? (
                    <p
                      id="pos-discount-problem"
                      role="alert"
                      className="text-body-sm text-status-danger-text"
                    >
                      {t(
                        discountProblemKey(priced.discountProblem, discount.mode, priced.currency),
                      )}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      <div className="sticky bottom-0 space-y-1.5 border-t border-border-default bg-surface-primary pt-3">
        {priced ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-label text-text-secondary">{t("pos.subtotal")}</span>
              <span className="text-body tnum min-w-0 text-right break-all text-text-primary">
                {formatMoney(priced.subtotal)}
              </span>
            </div>
            {priced.discount.amount > 0 ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-label text-text-secondary">{t("pos.discount.label")}</span>
                <span className="text-body tnum min-w-0 text-right break-all text-text-primary">
                  -{formatMoney(priced.discount)}
                </span>
              </div>
            ) : null}
            <div className="flex items-end justify-between gap-3">
              <span className="text-label text-text-secondary">{t("pos.total")}</span>
              <span className="flex min-w-0 flex-col items-end text-right">
                <span className="text-financial-lg tnum break-all text-text-primary">
                  {formatMoney(priced.total)}
                </span>
                <span className="text-data tnum text-text-muted">
                  {t("money.approx", { value: formatMoney(approximateCounterpart(priced.total)) })}
                </span>
              </span>
            </div>
          </>
        ) : (
          <MixedCurrencyNotice />
        )}
        <Button
          className="press tap-target elevation-action mt-1 h-12 w-full"
          disabled={block !== null || offline}
          onClick={onCheckout}
        >
          {t("pos.checkout")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Shown wherever a total would be when the cart holds more than one currency.
 * Nothing is summed or converted: the merchant removes one currency's items.
 */
export function MixedCurrencyNotice({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={cn("rounded-xl border border-border-default bg-status-danger-soft p-3", className)}
    >
      <p className="text-label text-status-danger-text">{t("pos.currency.mixedTitle")}</p>
      <p className="text-body-sm mt-1 text-text-primary">{t("pos.currency.mixedBody")}</p>
    </div>
  );
}
