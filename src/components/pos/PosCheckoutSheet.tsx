import { motion } from "motion/react";
import { Check } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { BottomSheet, CurrencyInput, ErrorState, StatusChip } from "@/design-system";
import { createSale } from "@/lib/api";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { calculateChange, formatMoney, usdToKhr } from "@/lib/money";
import { lineTotal, type CartLine, type CartTotals } from "@/lib/pos-cart";
import { cn } from "@/lib/utils";
import type { Customer, PaymentMethod, Sale } from "@/types";

interface PosCheckoutSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: CartLine[];
  totals: CartTotals;
  customer: Customer | null;
  offline: boolean;
  onCompleted: () => void;
}

const METHODS: PaymentMethod[] = ["cash", "khqr", "bank_transfer", "cod"];

export function PosCheckoutSheet({
  open,
  onOpenChange,
  lines,
  totals,
  customer,
  offline,
  onCompleted,
}: PosCheckoutSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();

  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [received, setReceived] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sale, setSale] = useState<Sale | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);

  // COD is only sensible when the sale is attached to a customer to deliver to.
  const methods = METHODS.filter((m) => m !== "cod" || customer !== null);
  const shortfall = method === "cash" && received < totals.total.amount;

  function reset() {
    setMethod("cash");
    setReceived(0);
    setSubmitting(false);
    setFailed(false);
    setSale(null);
    setShowReceipt(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      const completed = sale !== null;
      reset();
      onOpenChange(false);
      if (completed) onCompleted();
      return;
    }
    onOpenChange(true);
  }

  async function complete() {
    setSubmitting(true);
    setFailed(false);
    try {
      const created = await createSale({
        items: lines.map((l) => ({
          productId: l.productId,
          nameKm: l.nameKm,
          nameEn: l.nameEn,
          ...(l.variant ? { variant: l.variant } : {}),
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        })),
        subtotal: totals.subtotal,
        discount: totals.discount,
        total: totals.total,
        paymentMethod: method,
        ...(customer ? { customerId: customer.id } : {}),
      });
      setSale(created);
    } catch {
      setFailed(true);
    }
    setSubmitting(false);
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={sale ? undefined : t("pos.checkout")}
      snap="full"
      className="lg:max-w-[520px]"
    >
      {sale ? (
        <motion.div
          role="status"
          className="flex flex-col items-center py-6 text-center"
          initial={{ scale: 0.94, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.42, ease: [0.34, 1.3, 0.64, 1] }}
        >
          <span
            className="flex size-14 items-center justify-center rounded-full text-text-inverse"
            style={{ backgroundColor: "var(--companion-minto)" }}
          >
            <Check className="size-7" aria-hidden />
          </span>
          <h3 className="text-h3 mt-4 text-text-primary">{t("pos.success.title")}</h3>
          <p className="text-body mt-1 text-text-secondary">{sale.code}</p>
          <p className="text-financial-lg mt-2 text-text-primary">{formatMoney(sale.total)}</p>
          <p className="text-data text-text-muted">
            {t("money.approx", { value: formatMoney(usdToKhr(sale.total)) })}
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <StatusChip status={sale.paymentStatus} />
            <span className="text-caption text-text-secondary">
              {t(`pos.method.${sale.paymentMethod}`)}
            </span>
          </div>
          {sale.paymentStatus === "pending_payment" ? (
            <p className="text-body-sm mt-2 max-w-xs text-status-warning-text">
              {t("pos.success.codNote")}
            </p>
          ) : null}
          {customer ? (
            <p className="text-body-sm mt-2 text-text-secondary">
              {localName(customer, language)} · {customer.phone}
            </p>
          ) : null}

          {showReceipt ? (
            <ul className="mt-4 w-full space-y-1 border-t border-border-default pt-3 text-left">
              {sale.items.map((item) => (
                <li key={`${item.productId}-${item.variant ?? ""}`} className="flex justify-between gap-2">
                  <span className="text-body-sm min-w-0 truncate text-text-primary">
                    {localName(item, language)}
                    {item.variant ? ` · ${item.variant}` : ""} × {item.quantity}
                  </span>
                  <span className="text-data shrink-0 text-text-secondary">
                    {formatMoney({
                      amount: item.unitPrice.amount * item.quantity,
                      currency: item.unitPrice.currency,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-6 w-full space-y-2">
            <Button className="tap-target w-full" onClick={() => handleOpenChange(false)}>
              {t("pos.success.newSale")}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="tap-target flex-1"
                aria-expanded={showReceipt}
                onClick={() => setShowReceipt((v) => !v)}
              >
                {t("pos.success.viewReceipt")}
              </Button>
              <Button variant="outline" className="tap-target flex-1" disabled>
                {t("pos.success.viewOrder")}
              </Button>
            </div>
          </div>
        </motion.div>
      ) : (
        <div className="space-y-5">
          <ul className="space-y-1">
            {lines.map((line) => (
              <li key={line.key} className="flex justify-between gap-2">
                <span className="text-body-sm min-w-0 truncate text-text-primary">
                  {localName(line, language)}
                  {line.variant ? ` · ${line.variant}` : ""} × {line.quantity}
                </span>
                <span className="text-data shrink-0 text-text-secondary">
                  {formatMoney(lineTotal(line))}
                </span>
              </li>
            ))}
          </ul>

          <div className="space-y-1 border-t border-border-default pt-3">
            <div className="flex justify-between">
              <span className="text-label text-text-secondary">{t("pos.subtotal")}</span>
              <span className="text-body text-text-primary">{formatMoney(totals.subtotal)}</span>
            </div>
            {totals.discount.amount > 0 ? (
              <div className="flex justify-between">
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
            {customer ? (
              <p className="text-body-sm pt-1 text-text-secondary">
                {localName(customer, language)} · {customer.phone}
              </p>
            ) : null}
          </div>

          <fieldset>
            <legend className="text-label text-text-secondary">{t("pos.paymentMethod")}</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {methods.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={method === value}
                  onClick={() => setMethod(value)}
                  className={cn(
                    "tap-target rounded-xl border px-3 text-label transition-colors",
                    method === value
                      ? "border-action-primary bg-action-primary-soft text-action-primary"
                      : "border-border-strong bg-surface-primary text-text-primary",
                  )}
                >
                  <span className="chip-text">{t(`pos.method.${value}`)}</span>
                </button>
              ))}
            </div>
          </fieldset>

          {method === "cash" ? (
            <div className="space-y-2">
              <CurrencyInput
                id="pos-received"
                label={t("pos.cash.received")}
                value={received}
                onChange={setReceived}
              />
              <div className="flex justify-between">
                <span className="text-label text-text-secondary">{t("pos.cash.change")}</span>
                <span className="text-financial text-text-primary">
                  {shortfall
                    ? "—"
                    : formatMoney(calculateChange({ amount: received, currency: "USD" }, totals.total))}
                </span>
              </div>
              {shortfall ? (
                <p role="status" className="text-body-sm text-status-danger-text">
                  {t("pos.cash.shortfall")}
                </p>
              ) : null}
            </div>
          ) : null}

          {method === "khqr" || method === "bank_transfer" ? (
            <p className="text-body-sm rounded-xl bg-surface-secondary p-3 text-text-secondary">
              {t("pos.manualConfirm")}
            </p>
          ) : null}

          {method === "cod" ? (
            <p className="text-body-sm rounded-xl bg-status-warning-soft p-3 text-status-warning-text">
              {t("pos.codNote")}
            </p>
          ) : null}

          {offline ? (
            <p role="alert" className="text-body-sm text-status-danger-text">
              {t("pos.offline")}
            </p>
          ) : null}

          {failed ? (
            <ErrorState title={t("pos.error.title")} body={t("pos.error.body")} onRetry={() => void complete()} />
          ) : null}

          <Button
            className="tap-target w-full"
            disabled={submitting || offline || shortfall || lines.length === 0}
            onClick={() => void complete()}
          >
            {method === "khqr" || method === "bank_transfer"
              ? t("pos.markPaid")
              : t("pos.completeSale")}
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}
