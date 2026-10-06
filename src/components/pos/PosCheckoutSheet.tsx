import { motion, useReducedMotion } from "motion/react";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { createIdempotencyKeyHolder } from "@/lib/idempotency";
import { ordersKeys } from "@/lib/orders-query";
import { customerKeys } from "@/lib/customers-query";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { approximateCounterpart, calculateChange, formatMoney } from "@/lib/money";
import { classifyOrderError, isOrderCurrencyMismatch, type RealOrderDetail } from "@/lib/orders";
import { classifyPaymentError, paymentErrorKey } from "@/lib/payments";
import { UnpricedCartNotice } from "@/components/pos/PosCart";
import {
  checkoutBlock,
  classifyCheckout,
  lineTotal,
  type CartLine,
  type CartTotals,
} from "@/lib/pos-cart";
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
  /*
   * The cart's own refusal (mixed currencies, an invalid discount), applied
   * here as well as on every checkout button: this sheet is the last step
   * before createRealOrder, so it never relies on its opener having checked.
   * `priced` is null for a mixed-currency cart — there is no total to show or
   * send, so nothing below can render or submit one.
   */
  const block = checkoutBlock(totals);
  const priced = totals.kind === "priced" ? totals : null;

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
  const [realFailure, setRealFailure] = useState<"permission" | "currency" | "generic" | null>(
    null,
  );
  const submittingRef = useRef(false);

  /*
   * ── Checkout attempt identity ───────────────────────────────────────────
   *
   * A checkout's server calls outlive the state they were made for: the
   * merchant can close the sheet, change or replace the cart, start another
   * sale, or the session can switch member/organization while a create or
   * confirm is still in flight. Before this, every `await` resumed and wrote
   * unconditionally — a late USD create cleared a newer KHR cart (via
   * onCompleted) and painted the abandoned order's "Sale complete" over it.
   *
   * Every attempt now carries a token: which sheet session it belongs to,
   * which attempt it is, which principal/organization started it, and — until
   * an order exists — which cart it was built from. After EVERY await the
   * token is checked against the live values, and a stale response returns
   * without touching state, the cart, onCompleted or any cache. The server
   * may still have completed it (a draft order then exists, visible in
   * Orders); it just never mutates a newer browser state.
   *
   * sessionRef is bumped whenever the sheet's state is discarded (close,
   * cancel, principal/organization switch, unmount); attemptRef per attempt.
   */
  const sessionRef = useRef(0);
  const attemptRef = useRef(0);
  const discountMinor = priced?.discount.amount ?? 0;
  const liveRef = useRef({ userId, organizationId, lines, discountMinor });
  useEffect(() => {
    liveRef.current = { userId, organizationId, lines, discountMinor };
  });

  interface AttemptToken {
    session: number;
    attempt: number;
    userId: string;
    organizationId: string;
    /** The cart (lines + discount) the create was built from; null once an order exists. */
    cart: { lines: CartLine[]; discountMinor: number } | null;
  }

  function beginAttempt(boundToCart: boolean): AttemptToken {
    attemptRef.current += 1;
    return {
      session: sessionRef.current,
      attempt: attemptRef.current,
      userId,
      organizationId,
      cart: boundToCart ? { lines, discountMinor } : null,
    };
  }

  function isCurrent(token: AttemptToken): boolean {
    const live = liveRef.current;
    return (
      token.session === sessionRef.current &&
      token.attempt === attemptRef.current &&
      token.userId === live.userId &&
      token.organizationId === live.organizationId &&
      (token.cart === null ||
        (token.cart.lines === live.lines && token.cart.discountMinor === live.discountMinor))
    );
  }

  /*
   * A different member or organization is a different till: nothing the sheet
   * holds (an order, a failure, an in-flight attempt) belongs to it.
   */
  const principalKey = `${userId}\u0000${organizationId}`;
  const principalRef = useRef(principalKey);
  // The latest reset(), so the effect below depends on the principal alone.
  const resetRef = useRef<() => void>(() => {});
  useEffect(() => {
    resetRef.current = reset;
  });
  useEffect(() => {
    if (principalRef.current === principalKey) return;
    principalRef.current = principalKey;
    resetRef.current();
  }, [principalKey]);
  useEffect(
    () => () => {
      // Unmounted: whatever is still in flight has no screen left to update.
      sessionRef.current += 1;
    },
    [],
  );
  /*
   * createdOrderId only protects a retry whose create RESPONSE arrived. When
   * the request reached the server but the response was lost, createdOrderId
   * is still null and a retry calls createRealOrder again — so the create
   * itself carries an idempotency key (src/lib/idempotency.ts): the same cart
   * re-sends the same key and the server returns the order it already made.
   * Held across a sheet close (reset() leaves it alone) for the same reason;
   * released once the order exists, so the next sale is always a new order.
   */
  const idempotencyKeys = useRef(createIdempotencyKeyHolder());
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
    // The confirmed sale wrote stock movements; Inventory must not serve
    // pre-sale stock. Literal key (= inventoryKeys.principal in
    // src/lib/inventory.ts): that module's dynamic server-function imports
    // must not be pulled into the POS sheet's bundle.
    void queryClient.invalidateQueries({ queryKey: ["inventory", userId, organizationId] });
    // A sale attached to a customer is part of that customer's order history.
    if (customer) {
      void queryClient.invalidateQueries({
        queryKey: customerKeys.principal(userId, organizationId),
      });
    }
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
    // The sheet session this payment was recorded from — see "Checkout
    // attempt identity". A payment for an order the merchant has since walked
    // away from must not repaint (or re-open) a newer sheet.
    onMutate: () => ({ token: beginAttempt(false) }),
    onSuccess: async (_data, _submit, context) => {
      if (!context || !isCurrent(context.token)) return;
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
        const refreshed = await getRealOrderDetail(realDetail!.order.id);
        if (!isCurrent(context.token)) return;
        setRealDetail(refreshed);
      } catch {
        // The payment is recorded; only this optimistic re-read failed. The
        // caches are already invalidated, so Order detail will show the truth.
      }
    },
  });

  // COD is only sensible when the sale is attached to a customer to deliver to.
  const methods = METHODS.filter((m) => m !== "cod" || customer !== null);
  // The prototype cash path only (createSale, the /design mock catalog).
  const shortfall = method === "cash" && priced !== null && received < priced.total.amount;

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
    // Everything in flight now belongs to a discarded sheet state.
    sessionRef.current += 1;
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
    if (!priced || block) return;
    const token = beginAttempt(true);
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
        subtotal: priced.subtotal,
        discount: priced.discount,
        total: priced.total,
        paymentMethod: method,
        ...(customer ? { customerId: customer.id } : {}),
      });
      if (!isCurrent(token)) return;
      setSale(created);
    } catch {
      if (!isCurrent(token)) return;
      setFailed(true);
    } finally {
      if (token.session === sessionRef.current && token.attempt === attemptRef.current) {
        setSubmitting(false);
      }
    }
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
    let orderId = createdOrderId;
    // No order exists yet, so nothing may be created from a cart the cart
    // itself refuses: a mixed-currency cart or an invalid discount never
    // reaches the server. (Once an order exists the cart is already cleared,
    // and a retry only confirms that order — see below.)
    if (!orderId && (!priced || block)) return;
    submittingRef.current = true;
    setSubmitting(true);
    setRealFailure(null);
    // Bound to the cart only until an order exists; after that it is bound to
    // the order (this sheet session), and the cleared cart no longer matters.
    const token = beginAttempt(!orderId);
    try {
      // Tracked locally, not read back from state: the setRealDetail() calls
      // below are async/batched and would not be visible yet within this
      // same function run.
      let lifecycleStatus = realDetail?.order.lifecycleStatus;
      if (!orderId) {
        if (!priced) return; // unreachable: refused before the attempt began
        const created = await createRealOrder({
          source: "POS",
          items: lines.map((l) => ({
            // isRealCheckout guarantees every line has a production variantId.
            variantId: l.variantId!,
            quantity: l.quantity,
            productId: l.productId,
          })),
          customerId: customer && isProductionId(customer.id) ? customer.id : null,
          // Integer minor units in the cart's one currency — the only money
          // POS sends. The server prices every line itself, derives the
          // totals, and bounds this to 0 ≤ discount ≤ subtotal.
          ...(priced.discount.amount > 0 ? { discountMinor: priced.discount.amount } : {}),
          idempotency: idempotencyKeys.current,
        });
        // Abandoned (sheet closed, cart changed, another attempt began, or a
        // different member/organization): the order may exist server-side,
        // but this browser state is no longer the one that asked for it.
        if (!isCurrent(token)) return;
        token.cart = null;
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
        if (!isCurrent(token)) return;
        setRealDetail(confirmed);
        // Confirmation commits stock and moves the order's lifecycle, which
        // Orders, Inventory-facing reads and Home attention all reflect.
        invalidateAfterSale();
      }
    } catch (error) {
      if (!isCurrent(token)) return;
      setRealFailure(
        classifyOrderError(error) === "forbidden"
          ? "permission"
          : isOrderCurrencyMismatch(error)
            ? "currency"
            : "generic",
      );
    } finally {
      // Only the latest attempt of the live sheet session releases the guard.
      // A stale one must not release a guard a NEWER attempt holds (that would
      // re-open double submission); reset() already released it when the
      // stale attempt was abandoned. (A cart changed under the latest attempt
      // still releases it, so the merchant can check out the new cart.)
      if (token.session === sessionRef.current && token.attempt === attemptRef.current) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  const realConfirmed = realDetail?.order.lifecycleStatus === "confirmed";
  const failureKey =
    realFailure === "permission"
      ? "pos.permission"
      : realFailure === "currency"
        ? "pos.currency.serverMismatch"
        : "pos.orderError";

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
        // Pinned rather than the last thing in the scrollable body — the cash
        // path's own CurrencyInput scrolls itself into view on focus
        // (BottomSheet's keyboard-safe-field behaviour), which could otherwise
        // push "Complete Sale" off a 320/360px screen with the keyboard open.
        // Same fix as CreateRealOrderSheet/PrepareOrderSheet/PosVariantSheet.
        footer={
          !sale && !realDetail && checkoutKind !== "unsellable" && block === null ? (
            isRealCheckout ? (
              <Button
                className="tap-target w-full"
                disabled={submitting || offline || lines.length === 0}
                aria-busy={submitting}
                onClick={() => void completeReal()}
              >
                {submitting ? <Spinner /> : null}
                {submitting ? t("pos.confirming") : t("pos.confirmSale")}
              </Button>
            ) : (
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
            )
          ) : undefined
        }
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
              {t("money.approx", { value: formatMoney(approximateCounterpart(sale.total)) })}
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
              {/*
               * No "View order" here: this is the prototype createSale() path
               * (see classifyCheckout) — it never produces a real order id, so
               * there is nothing to view. A permanently-disabled button with no
               * explanation reads as broken; omitting it is the honest answer.
               */}
              <Button
                variant="outline"
                className="tap-target w-full"
                aria-expanded={showReceipt}
                onClick={() => setShowReceipt((v) => !v)}
              >
                {t("pos.success.viewReceipt")}
              </Button>
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
              {t("money.approx", {
                value: formatMoney(approximateCounterpart(realDetail.order.total)),
              })}
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
                    title={t(`${failureKey}.title`)}
                    body={t(`${failureKey}.body`)}
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
        ) : !priced || block === "discount" ? (
          /*
           * The cart refuses this sale before any server call: lines in more
           * than one currency (no honest total exists, and APSA never converts
           * one for the merchant), or a discount that is not valid for this
           * cart. Nothing is submitted; the cart is left exactly as it was.
           */
          <div className="space-y-5">
            {priced ? (
              <OperationalState
                tone="danger"
                title={t("pos.discount.blockedTitle")}
                body={t(
                  priced.discountProblem === "exceeds_subtotal"
                    ? "pos.discount.exceedsSubtotal"
                    : "pos.discount.fixShort",
                )}
              />
            ) : (
              <UnpricedCartNotice kind={totals.kind} />
            )}
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
                <span className="text-body text-text-primary">{formatMoney(priced.subtotal)}</span>
              </div>
              {priced.discount.amount > 0 ? (
                <div className="flex justify-between">
                  <span className="text-label text-text-secondary">{t("pos.discount.label")}</span>
                  <span className="text-body text-text-primary">
                    -{formatMoney(priced.discount)}
                  </span>
                </div>
              ) : null}
              <div className="flex items-end justify-between">
                <span className="text-label text-text-secondary">{t("pos.total")}</span>
                <span className="flex flex-col items-end">
                  <span className="text-financial-lg text-text-primary">
                    {formatMoney(priced.total)}
                  </span>
                  <span className="text-data text-text-muted">
                    {t("money.approx", {
                      value: formatMoney(approximateCounterpart(priced.total)),
                    })}
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
                title={t(`${failureKey}.title`)}
                body={t(`${failureKey}.body`)}
                // Retrying cannot change a price currency; the catalog has to.
                {...(realFailure === "currency" ? {} : { onRetry: () => void completeReal() })}
              />
            ) : null}
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
                <span className="text-body text-text-primary">{formatMoney(priced.subtotal)}</span>
              </div>
              {priced.discount.amount > 0 ? (
                <div className="flex justify-between">
                  <span className="text-label text-text-secondary">{t("pos.discount.label")}</span>
                  <span className="text-body text-text-primary">
                    -{formatMoney(priced.discount)}
                  </span>
                </div>
              ) : null}
              <div className="flex items-end justify-between">
                <span className="text-label text-text-secondary">{t("pos.total")}</span>
                <span className="flex flex-col items-end">
                  <span className="text-financial-lg text-text-primary">
                    {formatMoney(priced.total)}
                  </span>
                  <span className="text-data text-text-muted">
                    {t("money.approx", {
                      value: formatMoney(approximateCounterpart(priced.total)),
                    })}
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
                      "press tap-target inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 text-label transition-colors",
                      method === value
                        ? "border-action-primary bg-action-primary-soft text-action-primary"
                        : "border-border-strong bg-surface-primary text-text-primary",
                    )}
                  >
                    <span className="chip-text">{t(`pos.method.${value}`)}</span>
                    {method === value ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
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
                          calculateChange({ amount: received, currency: "USD" }, priced.total),
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
