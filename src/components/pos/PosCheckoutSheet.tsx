import { motion } from "motion/react";
import { Check } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { OperationalState } from "@/components/common/OperationalState";
import { BottomSheet, CurrencyInput, ErrorState, StatusChip } from "@/design-system";
import { confirmRealOrder, createRealOrder, createSale, isProductionId } from "@/lib/api";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { calculateChange, formatMoney, usdToKhr } from "@/lib/money";
import { classifyOrderError, type RealOrderDetail } from "@/lib/orders";
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

  // A cart reaches the authoritative Order Domain only when EVERY line
  // references a real, DB-backed product and variant. Any mock line (a
  // non-UUID id from the prototype catalog) routes the whole sale through the
  // untouched mock createSale() path below — browser-side UUID detection is
  // UX routing only, never authorization (the server independently validates
  // every id it receives).
  const isRealCheckout =
    lines.length > 0 &&
    lines.every((l) => isProductionId(l.productId) && isProductionId(l.variantId ?? ""));

  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [received, setReceived] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sale, setSale] = useState<Sale | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);

  // Real-order path state. `createdOrderId` survives a failed confirm so a
  // retry only re-attempts the confirm step — it never calls createRealOrder
  // twice for the same cart (see complete()'s own comment).
  const [createdOrderId, setCreatedOrderId] = useState<string | null>(null);
  const [realDetail, setRealDetail] = useState<RealOrderDetail | null>(null);
  const [realFailure, setRealFailure] = useState<"permission" | "generic" | null>(null);
  const submittingRef = useRef(false);

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
    setCreatedOrderId(null);
    setRealDetail(null);
    setRealFailure(null);
    submittingRef.current = false;
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      const completed = sale !== null || realDetail !== null;
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

  /**
   * Real Order Domain checkout. One merchant tap both creates the draft order
   * and confirms it — matching the product spec's single "Confirm Sale"
   * action — while staying retry-safe:
   *
   *   - submittingRef blocks a concurrent second call outright (double tap /
   *     double-fired touch event), checked synchronously before any await.
   *   - Once createRealOrder succeeds, createdOrderId is recorded and the
   *     cart is cleared immediately via onCompleted() — the order now exists
   *     as its own authoritative record, independent of local cart state, so
   *     there is nothing left to resubmit even across a sheet close or a
   *     page refresh that loses this component's state.
   *   - If the confirm step then fails (stale stock, permission, network),
   *     retrying calls this function again; because createdOrderId is
   *     already set it skips straight to confirmRealOrder on the SAME order
   *     — createRealOrder is never called twice for one cart.
   *
   * Payment is never touched here: the created/confirmed order's
   * paymentStatus is whatever the server defaults it to (unpaid). Nothing in
   * this function sets, infers, or displays a payment method as if it had
   * been collected — that is exclusively the Payment domain's decision.
   */
  async function completeReal() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setRealFailure(null);
    try {
      let orderId = createdOrderId;
      // Tracked locally, not read back from state: the setRealDetail() calls
      // below are async/batched and would not be visible yet within this
      // same function run.
      let lifecycleStatus = realDetail?.order.lifecycleStatus;
      if (!orderId) {
        const created = await createRealOrder({
          source: "POS",
          items: lines.map((l) => ({
            // isRealCheckout guarantees every line has a production variantId.
            variantId: l.variantId!,
            quantity: l.quantity,
            productId: l.productId,
          })),
          customerId: customer && isProductionId(customer.id) ? customer.id : null,
          ...(totals.discount.amount > 0 ? { discountMinor: totals.discount.amount } : {}),
        });
        orderId = created.order.id;
        lifecycleStatus = created.order.lifecycleStatus;
        setCreatedOrderId(orderId);
        setRealDetail(created);
        // The order now exists as its own record — the cart must never be
        // resubmitted against it, so it is cleared right away rather than
        // waiting for the sheet to close (see this function's own comment).
        onCompleted();
      }
      if (lifecycleStatus !== "confirmed") {
        const confirmed = await confirmRealOrder(orderId);
        setRealDetail(confirmed);
      }
    } catch (error) {
      setRealFailure(classifyOrderError(error) === "forbidden" ? "permission" : "generic");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const realConfirmed = realDetail?.order.lifecycleStatus === "confirmed";

  return (
    <BottomSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={sale || realDetail ? undefined : t("pos.checkout")}
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
                <li
                  key={`${item.productId}-${item.variant ?? ""}`}
                  className="flex justify-between gap-2"
                >
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
      ) : realDetail ? (
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
          <p className="text-body mt-1 text-text-secondary">{realDetail.order.code}</p>
          <p className="text-financial-lg mt-2 text-text-primary">
            {formatMoney(realDetail.order.total)}
          </p>
          <p className="text-data text-text-muted">
            {t("money.approx", { value: formatMoney(usdToKhr(realDetail.order.total)) })}
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <StatusChip status={realDetail.order.lifecycleStatus ?? "draft"} />
            <StatusChip status={realDetail.order.paymentStatus} />
          </div>
          {customer && isProductionId(customer.id) ? (
            <p className="text-body-sm mt-2 text-text-secondary">
              {localName(customer, language)} {customer.phone ? `· ${customer.phone}` : ""}
            </p>
          ) : null}

          {realConfirmed ? (
            <p className="text-body-sm mt-2 max-w-xs text-text-secondary">
              {t("pos.success.unpaidNote")}
            </p>
          ) : (
            <div className="mt-4 w-full space-y-3">
              <p className="text-body-sm text-status-warning-text">{t("pos.draftPendingBody")}</p>
              {realFailure ? (
                <OperationalState
                  tone="danger"
                  title={t(
                    realFailure === "permission" ? "pos.permission.title" : "pos.orderError.title",
                  )}
                  body={t(
                    realFailure === "permission" ? "pos.permission.body" : "pos.orderError.body",
                  )}
                  onRetry={() => void completeReal()}
                  className="py-2"
                />
              ) : (
                <Button
                  className="tap-target w-full"
                  disabled={submitting}
                  onClick={() => void completeReal()}
                >
                  {submitting ? t("pos.confirming") : t("pos.confirmSale")}
                </Button>
              )}
            </div>
          )}

          <div className="mt-6 w-full space-y-2">
            {realConfirmed ? (
              <Button className="tap-target w-full" onClick={() => handleOpenChange(false)}>
                {t("pos.success.newSale")}
              </Button>
            ) : null}
            <a
              href={`/app/orders/${realDetail.order.id}`}
              className="press tap-target text-label flex w-full items-center justify-center rounded-full border border-border-default px-4 py-3 text-text-primary"
            >
              {t("pos.success.viewOrder")}
            </a>
          </div>
        </motion.div>
      ) : isRealCheckout ? (
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
                {localName(customer, language)} {customer.phone ? `· ${customer.phone}` : ""}
              </p>
            ) : null}
          </div>

          {/* No payment method / cash-received UI on the real Order path: Confirm
              Sale never marks the order paid — that stays the Payment domain's
              decision (owned by Codex), applied later against this same order. */}

          {offline ? (
            <p role="alert" className="text-body-sm text-status-danger-text">
              {t("pos.offline")}
            </p>
          ) : null}

          {realFailure ? (
            <OperationalState
              tone="danger"
              title={t(
                realFailure === "permission" ? "pos.permission.title" : "pos.orderError.title",
              )}
              body={t(realFailure === "permission" ? "pos.permission.body" : "pos.orderError.body")}
              onRetry={() => void completeReal()}
            />
          ) : null}

          <Button
            className="tap-target w-full"
            disabled={submitting || offline || lines.length === 0}
            onClick={() => void completeReal()}
          >
            {submitting ? t("pos.confirming") : t("pos.confirmSale")}
          </Button>
        </div>
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
                    : formatMoney(
                        calculateChange({ amount: received, currency: "USD" }, totals.total),
                      )}
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
            <ErrorState
              title={t("pos.error.title")}
              body={t("pos.error.body")}
              onRetry={() => void complete()}
            />
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
