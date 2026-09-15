import { motion, useReducedMotion } from "motion/react";
import { Check } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { OperationalState } from "@/components/common/OperationalState";
import { BottomSheet, CurrencyInput, ErrorState, Spinner, StatusChip } from "@/design-system";
import {
  confirmRealOrder,
  createRealOrder,
  createSale,
  isProductionId,
  recordRealPayment,
} from "@/lib/api";
import {
  RecordOrderPaymentSheet,
  type RecordOrderPaymentSubmit,
} from "@/components/orders/RecordOrderPaymentSheet";
import { useCapabilities } from "@/hooks/use-capabilities";
import { HOME_QUERY_PREFIX } from "@/lib/home-query";
import { ordersKeys } from "@/lib/orders-query";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { calculateChange, formatMoney, usdToKhr } from "@/lib/money";
import { classifyOrderError, type RealOrderDetail } from "@/lib/orders";
import { classifyPaymentError, paymentErrorKey } from "@/lib/payments";
import { classifyCheckout, lineTotal, type CartLine, type CartTotals } from "@/lib/pos-cart";
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
  /**
   * The /app route guard's server-derived principal. Used only to address this
   * principal's own cache partitions after a sale — never sent to the server,
   * which derives both from the session on every call.
   */
  userId: string;
  organizationId: string;
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
  userId,
  organizationId,
}: PosCheckoutSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const reduceMotion = useReducedMotion();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();

  /*
   * The sale is done — one settled confirmation, not a celebration. Inside
   * the 160–260ms budget like every other transition, and an instant state
   * change when the merchant asked for reduced motion.
   */
  const successMotion = {
    initial: reduceMotion ? (false as const) : { scale: 0.96, opacity: 0 },
    animate: { scale: 1, opacity: 1 },
    transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.2, 0, 0, 1] as const },
  };

  /*
   * Which checkout this cart is allowed to use (see classifyCheckout).
   *
   * This used to be a two-way `every line production?` test whose false branch
   * ran the PROTOTYPE checkout. That degraded silently and dangerously: a real
   * product with no ACTIVE variant carries no variantId, so one such line sent
   * an entire cart of real goods into createSale() — a browser-fabricated
   * order code with a fabricated "paid" chip, for a sale no server had ever
   * recorded. `unsellable` now catches exactly that case and refuses, because
   * a cart APSA cannot turn into a real order must never be sold a receipt.
   *
   * Browser-side id inspection is UX routing only, never authorization — the
   * server independently validates every id it receives.
   */
  const checkoutKind = classifyCheckout(lines);
  const isRealCheckout = checkoutKind === "production";

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
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);

  /*
   * A sale that is confirmed but unpaid is unfinished work, so POS offers the
   * next step where the merchant already is rather than making them navigate
   * to Order detail to find it. Same component, same server function and the
   * same per-sheet idempotency key as Order detail — not a second way to take
   * money. Both keys are the permission the server itself requires
   * (payments.record, payments.mark_cod for COD); hiding a control decides
   * what is OFFERED, never what is ALLOWED.
   */
  const canRecordPayment = capabilities.can("payments.record");
  const canMarkCod = capabilities.can("payments.mark_cod");

  /**
   * Everything a POS sale makes stale, and nothing more.
   *
   * Without this the merchant rang up a real sale and then found Orders and
   * Home unchanged — the order existed on the server while every screen that
   * should show it served a pre-sale cache entry. Scoped to THIS principal's
   * own partitions: no queryClient.clear(), no cross-principal keys.
   */
  function invalidateAfterSale() {
    void queryClient.invalidateQueries({ queryKey: ordersKeys.principal(userId, organizationId) });
    void queryClient.invalidateQueries({ queryKey: ["payments", userId, organizationId] });
    void queryClient.invalidateQueries({ queryKey: HOME_QUERY_PREFIX });
  }

  const recordPaymentMutation = useMutation({
    mutationFn: (submit: RecordOrderPaymentSubmit) =>
      recordRealPayment({
        orderId: realDetail!.order.id,
        method: submit.method,
        amountMinor: submit.amountMinor,
        ...(submit.reference ? { reference: submit.reference } : {}),
        idempotencyKey: submit.idempotencyKey,
      }),
    onSuccess: async () => {
      setRecordPaymentOpen(false);
      invalidateAfterSale();
      /*
       * Re-read the order rather than patching a payment status onto it here.
       * record_payment_v1 writes every payment pending/unverified — cash
       * included — and derives the order's own payment axis in the same
       * transaction. The server's answer is the only honest one to show.
       */
      try {
        const { getRealOrderDetail } = await import("@/lib/api");
        setRealDetail(await getRealOrderDetail(realDetail!.order.id));
      } catch {
        // The payment is recorded; only this optimistic re-read failed. The
        // caches are already invalidated, so Order detail will show the truth.
      }
    },
  });

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
    setRecordPaymentOpen(false);
    recordPaymentMutation.reset();
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
        // It also exists for every other screen from this moment, so they stop
        // serving a pre-sale cache entry now rather than after the confirm.
        invalidateAfterSale();
      }
      if (lifecycleStatus !== "confirmed") {
        const confirmed = await confirmRealOrder(orderId);
        setRealDetail(confirmed);
        // Confirmation commits stock and moves the order's lifecycle, which
        // Orders, Inventory-facing reads and Home attention all reflect.
        invalidateAfterSale();
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
    <>
      <BottomSheet
        /*
         * Stood down while the payment sheet is up, so exactly ONE focus trap
         * is ever active.
         *
         * BottomSheet registers its Escape and focusin handlers on `document`
         * (see its open effect), not on its own panel. Two open sheets
         * therefore run two document-level traps regardless of how they are
         * nested: each sees focus landing in the other as "outside me" and
         * calls its own panel.focus(), so focus ping-pongs between them and
         * the merchant cannot type an amount. Escape is worse — both handlers
         * fire, so dismissing the payment sheet also tore down the checkout
         * sheet, and with it the confirmed-but-unpaid order the merchant was
         * in the middle of settling.
         *
         * This is presentation only: `open` is untouched and no state is
         * reset, so realDetail, the order id and the success surface all
         * survive and come straight back when the payment sheet closes.
         * handleOpenChange is never reached by this, so onCompleted() cannot
         * fire from stepping into payment entry.
         */
        open={open && !recordPaymentOpen}
        onOpenChange={handleOpenChange}
        title={sale || realDetail ? undefined : t("pos.checkout")}
        snap="full"
        className="lg:max-w-[520px]"
      >
        {sale ? (
          <motion.div
            role="status"
            className="flex flex-col items-center py-6 text-center"
            {...successMotion}
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
            {...successMotion}
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
            ) : null}

            {/*
             * The sale is real and the money is still outstanding, so the money
             * step is the primary action — not "New sale", which would walk away
             * from an unpaid order. `paymentStatus` is the server's own axis:
             * this never infers payment from the order being confirmed, and the
             * button disappears on its own once the server says otherwise.
             */}
            {realConfirmed && realDetail.order.paymentStatus === "unpaid" && canRecordPayment ? (
              <Button className="tap-target mt-4 w-full" onClick={() => setRecordPaymentOpen(true)}>
                {t("pos.success.recordPayment")}
              </Button>
            ) : null}

            {!realConfirmed ? (
              <div className="mt-4 w-full space-y-3">
                <p className="text-body-sm text-status-warning-text">{t("pos.draftPendingBody")}</p>
                {realFailure ? (
                  <OperationalState
                    tone="danger"
                    title={t(
                      realFailure === "permission"
                        ? "pos.permission.title"
                        : "pos.orderError.title",
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
                    aria-busy={submitting}
                    onClick={() => void completeReal()}
                  >
                    {submitting ? <Spinner /> : null}
                    {submitting ? t("pos.confirming") : t("pos.confirmSale")}
                  </Button>
                )}
              </div>
            ) : null}

            <div className="mt-6 w-full space-y-2">
              {realConfirmed ? (
                <Button
                  className="tap-target w-full"
                  variant={realDetail.order.paymentStatus === "unpaid" ? "outline" : "default"}
                  onClick={() => handleOpenChange(false)}
                >
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
        ) : checkoutKind === "unsellable" ? (
          /*
           * No sale is possible from this cart, so no sale is offered. In
           * practice this is a real product whose catalog row has no ACTIVE
           * variant to price or draw stock from — the merchant is told which
           * lines and sent to fix the catalog, rather than handed a fabricated
           * receipt (which is what this branch replaced).
           */
          <div className="space-y-5">
            <OperationalState
              tone="danger"
              title={t("pos.unsellable.title")}
              body={t("pos.unsellable.body")}
            />
            <ul className="space-y-1">
              {lines
                .filter((l) => !isProductionId(l.variantId ?? ""))
                .map((line) => (
                  <li key={line.key} className="flex justify-between gap-2">
                    <span className="text-body-sm min-w-0 truncate text-text-primary">
                      {localName(line, language)}
                    </span>
                    <span className="text-caption shrink-0 text-status-danger-text">
                      {t("pos.unsellable.noVariant")}
                    </span>
                  </li>
                ))}
            </ul>
            <Button
              variant="outline"
              className="tap-target w-full"
              onClick={() => handleOpenChange(false)}
            >
              {t("pos.unsellable.back")}
            </Button>
          </div>
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
                  <span className="text-body text-text-primary">
                    -{formatMoney(totals.discount)}
                  </span>
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
                body={t(
                  realFailure === "permission" ? "pos.permission.body" : "pos.orderError.body",
                )}
                onRetry={() => void completeReal()}
              />
            ) : null}

            <Button
              className="tap-target w-full"
              disabled={submitting || offline || lines.length === 0}
              aria-busy={submitting}
              onClick={() => void completeReal()}
            >
              {submitting ? <Spinner /> : null}
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
                  <span className="text-body text-text-primary">
                    -{formatMoney(totals.discount)}
                  </span>
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
                      "press tap-target rounded-xl border px-3 text-label transition-colors",
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
              aria-busy={submitting}
              onClick={() => void complete()}
            >
              {submitting ? <Spinner /> : null}
              {submitting
                ? t("pos.confirming")
                : method === "khqr" || method === "bank_transfer"
                  ? t("pos.markPaid")
                  : t("pos.completeSale")}
            </Button>
          </div>
        )}
      </BottomSheet>

      {/*
       * A SIBLING of the checkout sheet, never a child: BottomSheet runs its own
       * focus trap that pulls focus back inside itself, and nesting one inside
       * another sets the two traps against each other. Mounted only once a real
       * order exists, so there is always an authoritative order id to record
       * against — never a fabricated one.
       */}
      {realDetail ? (
        <RecordOrderPaymentSheet
          open={recordPaymentOpen}
          onOpenChange={(next) => {
            setRecordPaymentOpen(next);
            // A failure belongs to the attempt that produced it — reopening for
            // a fresh attempt must not show the last one's error over an empty
            // form (same reset Order detail's own usage does).
            if (!next) recordPaymentMutation.reset();
          }}
          orderTotal={realDetail.order.total}
          canRecord={canRecordPayment}
          canMarkCod={canMarkCod}
          pending={recordPaymentMutation.isPending}
          error={
            recordPaymentMutation.error
              ? t(paymentErrorKey(classifyPaymentError(recordPaymentMutation.error)))
              : null
          }
          onConfirm={(submit) => recordPaymentMutation.mutate(submit)}
        />
      ) : null}
    </>
  );
}
