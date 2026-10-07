import { motion } from "motion/react";
import { Check, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BottomSheet, ErrorState, QuantityStepper } from "@/design-system";
import { DeliveryFeeField } from "@/components/orders/DeliveryFeeField";
import { ShippingIntentSection } from "@/components/orders/ShippingIntentSection";
import {
  type ShippingDestinationValue,
  EMPTY_SHIPPING_DESTINATION,
  orderShippingPayload,
  shippingIntentReady,
} from "@/lib/shipping-destination";
import {
  createOrder,
  createRealOrder,
  confirmRealOrder,
  cancelRealOrder,
  isProductionId,
  PERMISSION_DENIED,
} from "@/lib/api";
import { localName } from "@/lib/format";
import { sharedIdempotencyHolder } from "@/lib/idempotency";
import { useLanguage } from "@/lib/i18n";
import {
  classifyOrderError,
  channelToSourceDb,
  classifyPreparedOrder,
  explainUnsellablePreparedOrder,
  isOrderCurrencyMismatch,
  type PreparedOrderBlocker,
  type RealOrderDetail,
} from "@/lib/orders";
import { formatMoney } from "@/lib/money";
import {
  calculateDraftTotals,
  defaultProductVariantId,
  defaultVariantSelection,
  draftBlock,
  draftCurrency,
  needsVariantChoice,
  NO_DELIVERY_FEE,
  productVariantPrice,
  variantLabel,
  type DraftDeliveryFee,
} from "@/lib/order-draft";
import { cartCurrencyContext, lineTotal, NO_DISCOUNT } from "@/lib/pos-cart";
import type { PrepareOrderItemInput } from "@/lib/conversation/smart-actions";
import { cn } from "@/lib/utils";
import type { Channel, Customer, Money, Order, Product } from "@/types";

interface PrepareOrderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: Customer;
  displayName: string;
  channel: Channel;
  /** the merchant's catalog — already fetched by the caller, never refetched here */
  products: Product[];
  /** review-step starting point; empty array means "start from a blank search" */
  initialItems: PrepareOrderItemInput[];
  /**
   * Opaque provenance identifier for the conversation this order came from.
   * Only ever sent on the production create-order call — see migration 030's
   * own comment on why this is never a Conversation FK or content.
   */
  sourceConversationRef?: string | null;
  /** Fires exactly once, when the order first exists (draft or, for the mock path, final). */
  onCreated: (order: Order) => void;
  /** Fires when a draft is confirmed — a status update, not a second "created" event. */
  onConfirmed?: (order: Order) => void;
  /**
   * Who is creating the order, and for which conversation. Scopes the create's
   * idempotency key, which must outlive this sheet (see idempotencyKeys).
   */
  replayScope: { userId: string; organizationId: string; conversationId: string };
}

let lineKeySeq = 0;
function nextLineKey(): string {
  lineKeySeq += 1;
  return `line-${lineKeySeq}`;
}

interface EditableLine {
  key: string;
  quantity: number;
  product: Product | null;
  variant: Record<string, string>;
  /**
   * The chosen production variant, when `product.productionVariants` holds
   * more than one ACTIVE variant. Null means "not chosen yet" and blocks
   * submit — mirroring PosVariantSheet's "never guess between multiple
   * variants" rule, which this sheet used to skip entirely by always
   * submitting `product.variantId` (the first ACTIVE variant returned by the
   * server), regardless of which one the customer actually wants.
   */
  variantId: string | null;
  /** shown as a picker until the merchant chooses one, or searches instead */
  candidates: Product[];
  query: string;
}

/**
 * The chosen variant's own price when one exists, else the product's own
 * price. Delegates to the shared rule in @/lib/order-draft so this sheet,
 * CreateRealOrderSheet and POS cannot drift apart on variant pricing.
 */
function linePrice(line: EditableLine): Money {
  return productVariantPrice(line.product, line.variantId);
}

function toEditableLine(input: PrepareOrderItemInput): EditableLine {
  return {
    key: nextLineKey(),
    quantity: Math.max(1, Math.trunc(input.quantity) || 1),
    product: input.product ?? null,
    variant: input.product ? defaultVariantSelection(input.product.options) : {},
    variantId: defaultProductVariantId(input.product ?? null),
    candidates: input.candidates ?? [],
    query: "",
  };
}

type Step =
  | { name: "review" }
  | { name: "created-mock"; order: Order }
  | { name: "created-real"; detail: RealOrderDetail };

export function PrepareOrderSheet({
  open,
  onOpenChange,
  customer,
  displayName,
  channel,
  products,
  initialItems,
  sourceConversationRef,
  onCreated,
  onConfirmed,
  replayScope,
}: PrepareOrderSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();

  const [lines, setLines] = useState<EditableLine[]>(() =>
    (initialItems.length > 0 ? initialItems : [{ quantity: 1 }]).map(toEditableLine),
  );
  const [step, setStep] = useState<Step>({ name: "review" });
  const [submitting, setSubmitting] = useState(false);
  /** The draft operation in flight (see "Draft operations"), for the buttons. */
  const [operation, setOperation] = useState<"confirm" | "discard" | null>(null);
  const [failure, setFailure] = useState<"generic" | "permission" | "currency" | null>(null);
  const [blocker, setBlocker] = useState<PreparedOrderBlocker | null>(null);
  const [deliveryFee, setDeliveryFee] = useState<DraftDeliveryFee>(NO_DELIVERY_FEE);
  /*
   * Optional order shipping destination for the production path — the parcel's
   * authoritative destination, snapshotted onto the order (§13). Prefilled with
   * the conversation customer's name/phone as a convenience. That prefill is
   * dormant: shipping is sent only when the merchant explicitly turns it on, so
   * partial Inbox contact details never turn a pickup order into a shipment.
   */
  const [shipIntent, setShipIntent] = useState(false);
  const [shipping, setShipping] = useState<ShippingDestinationValue>(() => ({
    ...EMPTY_SHIPPING_DESTINATION,
    name: displayName,
    phone: customer.phone ?? "",
  }));
  const submittingRef = useRef(false);
  /*
   * One idempotency key per logical order attempt (src/lib/idempotency.ts).
   * A retry of the same request re-sends the same key, so a create whose
   * response was lost is replayed by the server rather than duplicated.
   *
   * Each create attempt takes its own CLAIM on the key and retires it only
   * once this sheet ACCEPTS the response (see "Attempt identity" below) —
   * never on arrival. An abandoned attempt's late success therefore leaves
   * the key held, so an identical resubmission is answered with the order the
   * server already made; and "Edit" (cancel the draft, rebuild) after an
   * accepted create still gets a genuinely new order from identical lines.
   *
   * The holder is NOT this sheet's: the conversation route remounts the sheet
   * on every conversation/member/organization change, and an unresolved
   * create must keep its key across that ("pending in A → B → back to A →
   * retry" must be replayed by the server, not become a second order). It is
   * owned by the page-lifetime registry, scoped to this member, this
   * organization and this conversation — never reachable from another.
   */
  const { userId, organizationId, conversationId } = replayScope;
  const idempotencyKeys = useMemo(
    () =>
      sharedIdempotencyHolder({
        userId,
        organizationId,
        flow: "inbox-prepare-order",
        subject: conversationId,
      }),
    [userId, organizationId, conversationId],
  );

  /*
   * ── Attempt identity ────────────────────────────────────────────────────
   *
   * A create/confirm can outlive the draft it was made for: the merchant can
   * close the sheet (and reopen a fresh draft) while it is in flight, and the
   * conversation route remounts this sheet when the conversation, member or
   * organization changes. Each attempt carries the sheet session it began in;
   * a response arriving after that session ended is dropped — it never
   * paints "created" over a newer draft, reports onCreated into another
   * thread, or shows an old failure. (The server may still have created the
   * draft order; it is visible in Orders, and an identical resubmission is
   * answered with it.) The draft itself is locked while a create is pending,
   * so within one session the lines cannot change under a request.
   */
  const sessionRef = useRef(0);
  const attemptRef = useRef(0);
  useEffect(
    () => () => {
      // Unmounted: whatever is still in flight has no screen left to update.
      sessionRef.current += 1;
    },
    [],
  );
  function beginAttempt() {
    attemptRef.current += 1;
    return { session: sessionRef.current, attempt: attemptRef.current };
  }
  function isCurrent(token: { session: number; attempt: number }): boolean {
    return token.session === sessionRef.current && token.attempt === attemptRef.current;
  }

  function reset() {
    sessionRef.current += 1;
    setLines((initialItems.length > 0 ? initialItems : [{ quantity: 1 }]).map(toEditableLine));
    setStep({ name: "review" });
    setSubmitting(false);
    // Any confirm/discard in flight belonged to the session just ended.
    operationRef.current = null;
    setOperation(null);
    setFailure(null);
    setBlocker(null);
    setDeliveryFee(NO_DELIVERY_FEE);
    setShipping({ ...EMPTY_SHIPPING_DESTINATION, name: displayName, phone: customer.phone ?? "" });
    setShipIntent(false);
    submittingRef.current = false;
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  /*
   * However the sheet was closed — its own close control above, or the parent
   * setting `open` to false — the draft session ends with it, so a response
   * still in flight can never land on whatever is opened next.
   */
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    if (!open) resetRef.current();
  }, [open]);

  function updateLine(key: string, patch: Partial<EditableLine>) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function removeLine(key: string) {
    setLines((prev) => (prev.length > 1 ? prev.filter((line) => line.key !== key) : prev));
  }

  function pickProduct(key: string, product: Product) {
    updateLine(key, {
      product,
      candidates: [],
      variant: defaultVariantSelection(product.options),
      variantId: defaultProductVariantId(product),
      query: "",
    });
  }

  const realCustomer = isProductionId(customer.id);

  const itemsReady =
    lines.length > 0 &&
    lines.every(
      (line) =>
        Boolean(line.product) && (!needsVariantChoice(line.product!) || Boolean(line.variantId)),
    );

  /** The chosen lines, for naming the ones that blocked the order. */
  const readyLinesForDisplay = useMemo(
    () =>
      lines.filter((line): line is EditableLine & { product: Product } => Boolean(line.product)),
    [lines],
  );

  /** Each chosen line's price and quantity — the only inputs to the money preview. */
  const pricedLines = useMemo(
    () =>
      readyLinesForDisplay.map((line) => ({ unitPrice: linePrice(line), quantity: line.quantity })),
    [readyLinesForDisplay],
  );

  /*
   * A delivery fee belongs to the currency context it was typed in. When the
   * draft's currencies change — dollars → riel, single → mixed, anything →
   * empty — the fee is CLEARED (adjusted during render, so no frame ever
   * shows the old text against the new currency), never kept dormant to
   * reappear as "$5" when the draft returns to dollars.
   */
  const currencyContext = cartCurrencyContext(pricedLines);
  const [feeContext, setFeeContext] = useState(currencyContext);
  if (feeContext !== currencyContext) {
    setFeeContext(currencyContext);
    setDeliveryFee(NO_DELIVERY_FEE);
  }

  /*
   * The delivery fee is a real Order amount only on the production path
   * (migration 044); the prototype path has no server to charge it.
   */
  const totals = calculateDraftTotals(
    pricedLines,
    NO_DISCOUNT,
    realCustomer ? deliveryFee : NO_DELIVERY_FEE,
  );
  const moneyBlock = draftBlock(totals);
  const priced = totals.kind === "priced" ? totals : null;

  const readyToSubmit =
    itemsReady && moneyBlock === null && shippingIntentReady(shipIntent, shipping);

  async function submit() {
    if (submittingRef.current || !readyToSubmit || !priced) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    setBlocker(null);
    const token = beginAttempt();

    const readyLines = readyLinesForDisplay;

    /*
     * Three-way, never two-way. The old test was "is this fully production?",
     * and its false branch ran the local path — which reports an order code to
     * the merchant and appends "Order created" to the conversation while
     * persisting nothing. A real conversation on an unclassified channel, and
     * a real product with no ACTIVE variant, both took that branch with real
     * customers and real goods. `unsellable` catches exactly those and refuses
     * with a reason. See classifyPreparedOrder for the full account.
     *
     * Browser-side id inspection is UX routing only, never authorization — the
     * server independently validates every id it receives.
     */
    const prepared = {
      channel,
      customerId: customer.id,
      lines: readyLines.map((line) => ({
        productId: line.product.id,
        variantId: line.variantId,
      })),
    };
    const kind = classifyPreparedOrder(prepared);

    if (kind === "unsellable") {
      setBlocker(explainUnsellablePreparedOrder(prepared));
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }

    try {
      if (kind === "production") {
        // This attempt's own claim on the replay key (see idempotencyKeys).
        const claim = idempotencyKeys.claim();
        // classifyPreparedOrder returned "production", which is true only when
        // the channel maps to a writable DB source and every line carries a
        // real variant. Both non-null assertions are that guarantee.
        const detail = await createRealOrder({
          source: channelToSourceDb(channel)!,
          items: readyLines.map((line) => ({
            variantId: line.variantId!,
            quantity: line.quantity,
            productId: line.product.id,
          })),
          customerId: customer.id,
          ...(sourceConversationRef ? { sourceConversationRef } : {}),
          // Integer minor units in the draft's one currency — the only money
          // this sends. The server prices the lines and derives every total.
          ...(priced.deliveryFee.amount > 0 ? { deliveryMinor: priced.deliveryFee.amount } : {}),
          ...(orderShippingPayload(shipIntent, shipping)
            ? { shipping: orderShippingPayload(shipIntent, shipping)! }
            : {}),
          idempotency: claim,
        });
        // Abandoned (closed, conversation/member switched, unmounted): the
        // order may exist server-side, but this is no longer the draft that
        // asked for it. Its key is NOT retired (see idempotencyKeys).
        if (!isCurrent(token)) return;
        claim.retire();
        setStep({ name: "created-real", detail });
        onCreated(detail.order);
      } else {
        // Every Money in the draft's own currency — never a USD zero beside
        // riel lines. The prototype path charges no delivery fee.
        const order = await createOrder({
          customerId: customer.id,
          channel,
          items: readyLines.map((line) => ({
            productId: line.product.id,
            nameKm: line.product.nameKm,
            nameEn: line.product.nameEn,
            ...(variantLabel(line.variant) ? { variant: variantLabel(line.variant)! } : {}),
            quantity: line.quantity,
            unitPrice: line.product.price,
          })),
          subtotal: priced.subtotal,
          discount: priced.discount,
          deliveryFee: priced.deliveryFee,
          total: priced.total,
        });
        if (!isCurrent(token)) return;
        setStep({ name: "created-mock", order });
        onCreated(order);
      }
    } catch (error) {
      if (!isCurrent(token)) return;
      if (error instanceof Error && error.message === PERMISSION_DENIED) {
        setFailure("permission");
      } else if (classifyOrderError(error) === "forbidden") {
        setFailure("permission");
      } else {
        setFailure(isOrderCurrencyMismatch(error) ? "currency" : "generic");
      }
    } finally {
      // Only the live attempt releases the guard: reset() already released
      // it for an abandoned one, and a newer attempt may hold it now.
      if (isCurrent(token)) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  /*
   * ── Draft operations: confirm OR discard, never both ────────────────────
   *
   * A created draft offers two server operations, and they conflict: one
   * confirms the order, the other cancels it. They used to share the create's
   * attempt counter, so starting a discard while a confirm was pending made
   * the confirm "stale" — its finally then refused to clear `confirming`, and
   * the next draft's button stayed stuck on "Confirming…" for good.
   *
   * Now they share ONE operation slot, taken synchronously (a ref, not state,
   * so a double tap cannot start two): while either is in flight the other's
   * control is disabled and its handler refuses. Each operation is an object
   * identity; only the operation that still owns the slot — in the sheet
   * session it began in — may write state or release the slot. reset() (close,
   * reopen) empties the slot and ends the session, so a late callback can
   * neither touch the new draft nor leave it looking busy.
   */
  type DraftOperation = { kind: "confirm" | "discard"; session: number };
  const operationRef = useRef<DraftOperation | null>(null);
  function beginOperation(kind: DraftOperation["kind"]): DraftOperation | null {
    if (operationRef.current) return null;
    const op = { kind, session: sessionRef.current };
    operationRef.current = op;
    setOperation(kind);
    return op;
  }
  function ownsOperation(op: DraftOperation): boolean {
    return operationRef.current === op && op.session === sessionRef.current;
  }
  function endOperation(op: DraftOperation) {
    if (!ownsOperation(op)) return;
    operationRef.current = null;
    setOperation(null);
  }

  async function confirm() {
    if (step.name !== "created-real") return;
    const op = beginOperation("confirm");
    if (!op) return;
    setFailure(null);
    try {
      const confirmed = await confirmRealOrder(step.detail.order.id);
      if (!ownsOperation(op)) return;
      setStep({ name: "created-real", detail: confirmed });
      onConfirmed?.(confirmed.order);
    } catch (error) {
      if (!ownsOperation(op)) return;
      setFailure(classifyOrderError(error) === "forbidden" ? "permission" : "generic");
    } finally {
      endOperation(op);
    }
  }

  /**
   * "Edit" on an already-created draft cannot patch the persisted order — the
   * Order domain deliberately has no arbitrary update path (see
   * src/server/orders/service.ts). The honest equivalent is: cancel the draft
   * (a real, supported transition that reverses nothing, since a draft never
   * consumed stock) and let the merchant build a fresh one from the same
   * starting lines.
   */
  async function discardAndEdit() {
    if (step.name !== "created-real") return;
    const op = beginOperation("discard");
    if (!op) return;
    try {
      await cancelRealOrder(step.detail.order.id, "Merchant edited before confirming");
    } catch {
      // Best-effort: if cancellation fails (e.g. permission), the merchant can
      // still cancel it later from Order Detail. Editing must not get stuck.
    }
    if (!ownsOperation(op)) return;
    endOperation(op);
    setFailure(null);
    setStep({ name: "review" });
  }

  const failureCopy =
    failure === "permission"
      ? "conversation.prepareOrder.permission"
      : failure === "currency"
        ? "conversation.prepareOrder.currency.serverMismatch"
        : "conversation.prepareOrder.error";

  return (
    <BottomSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={step.name === "review" ? t("conversation.prepareOrder.reviewTitle") : undefined}
      snap="full"
      className="lg:max-w-[520px]"
      /*
       * Pinned rather than the last thing in the scrollable body: a review
       * with several item cards, or the product-search field's own
       * scroll-into-view on focus, could push this button out of reach —
       * exactly the form BottomSheet's `footer` slot exists to prevent (see
       * its own comment). Only the review step needs this; the "created"
       * steps are short celebration screens whose actions were never at risk
       * of scrolling away.
       */
      footer={
        step.name === "review" ? (
          <div>
            <Button
              className="tap-target h-12 w-full"
              disabled={!readyToSubmit || submitting}
              onClick={() => void submit()}
            >
              {submitting
                ? t("conversation.prepareOrder.creating")
                : t(
                    isProductionId(customer.id)
                      ? "conversation.prepareOrder.createDraft"
                      : "conversation.prepareOrder.createOrder",
                  )}
            </Button>
            {!itemsReady ? (
              <p className="text-caption mt-2 text-center text-text-muted">
                {t("conversation.prepareOrder.resolveItemsFirst")}
              </p>
            ) : moneyBlock === "mixed_currency" || moneyBlock === "out_of_range" ? (
              <p className="text-caption mt-2 text-center text-status-danger-text">
                {t(
                  moneyBlock === "mixed_currency"
                    ? "conversation.prepareOrder.currency.mixedShort"
                    : "conversation.prepareOrder.currency.tooLargeShort",
                )}
              </p>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {step.name === "review" ? (
        /*
         * The whole draft is inert while a create is in flight: the request
         * was built from these lines and this fee, so editing them under it
         * would leave the merchant looking at an order that is not the one
         * being created. (The footer button is outside, and already disabled.)
         */
        <fieldset disabled={submitting} className="m-0 min-w-0 space-y-5 border-0 p-0 pb-4">
          <section className="rounded-xl border border-border-default bg-surface-secondary px-3 py-2.5">
            <p className="text-caption text-text-muted">
              {t("conversation.prepareOrder.customer")}
            </p>
            <p className="text-label text-text-primary">{displayName}</p>
          </section>

          {lines.map((line, index) => (
            <section
              key={line.key}
              className="space-y-3 rounded-xl border border-border-default p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-caption text-text-muted">
                  {t("conversation.prepareOrder.item", { index: index + 1 })}
                </p>
                {lines.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeLine(line.key)}
                    aria-label={t("conversation.prepareOrder.remove")}
                    className="tap-target flex size-8 items-center justify-center rounded-full text-text-muted"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
              </div>

              {line.product ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="chip-text text-label text-text-primary">
                        {localName(line.product, language)}
                      </p>
                      <p className="text-data text-text-muted">{line.product.sku}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => updateLine(line.key, { product: null, query: "" })}
                      className="tap-target text-label shrink-0 px-2 text-action-primary"
                    >
                      {t("conversation.prepareOrder.changeProduct")}
                    </button>
                  </div>

                  {needsVariantChoice(line.product) ? (
                    <div>
                      <p className="text-label text-text-secondary">{t("pos.variant.chooseOne")}</p>
                      <ul className="mt-2 space-y-2">
                        {line.product.productionVariants!.map((v) => {
                          const selected = v.variantId === line.variantId;
                          return (
                            <li key={v.variantId}>
                              <button
                                type="button"
                                aria-pressed={selected}
                                onClick={() => updateLine(line.key, { variantId: v.variantId })}
                                className={cn(
                                  "tap-target flex w-full items-center gap-2 rounded-xl border px-4 py-2.5 text-left transition-colors",
                                  selected
                                    ? "border-action-primary bg-action-primary-soft text-action-primary"
                                    : "border-border-strong bg-surface-primary text-text-primary",
                                )}
                              >
                                <span className="chip-text min-w-0 flex-1 text-label">
                                  {v.name}
                                </span>
                                <span className="text-financial shrink-0">
                                  {formatMoney(v.price)}
                                </span>
                                {selected ? (
                                  <Check
                                    className="size-4 shrink-0 text-action-primary"
                                    aria-hidden
                                  />
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : (
                    line.product.options?.map((option) => (
                      <div key={option.name}>
                        <p className="text-label text-text-secondary capitalize">{option.name}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {option.values.map((value) => {
                            const selected = line.variant[option.name] === value;
                            return (
                              <button
                                key={value}
                                type="button"
                                aria-pressed={selected}
                                onClick={() =>
                                  updateLine(line.key, {
                                    variant: { ...line.variant, [option.name]: value },
                                  })
                                }
                                className={cn(
                                  "tap-target inline-flex items-center gap-1.5 rounded-full border px-4 text-label transition-colors",
                                  selected
                                    ? "border-action-primary bg-action-primary text-text-on-action"
                                    : "border-border-strong bg-surface-primary text-text-primary",
                                )}
                              >
                                <span className="chip-text">{value}</span>
                                {selected ? (
                                  <Check className="size-3.5 shrink-0" aria-hidden />
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))
                  )}

                  <div className="flex items-center justify-between gap-3">
                    <span className="text-label text-text-secondary">
                      {t("conversation.prepareOrder.quantity")}
                    </span>
                    <QuantityStepper
                      value={line.quantity}
                      onChange={(quantity) => updateLine(line.key, { quantity })}
                      {...(line.product.stock != null ? { max: line.product.stock } : {})}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-body-sm text-text-secondary">
                      {formatMoney(linePrice(line))} × {line.quantity}
                    </span>
                    <span className="text-financial text-text-primary">
                      {formatMoney(
                        lineTotal({ unitPrice: linePrice(line), quantity: line.quantity }),
                      )}
                    </span>
                  </div>
                </div>
              ) : line.candidates.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-body-sm text-text-secondary">
                    {t("conversation.prepareOrder.multipleMatches")}
                  </p>
                  <ul className="space-y-2">
                    {line.candidates.map((candidate) => (
                      <li key={candidate.id}>
                        <button
                          type="button"
                          onClick={() => pickProduct(line.key, candidate)}
                          className="tap-target flex w-full items-center justify-between gap-3 rounded-xl border border-border-default bg-surface-primary px-3 py-2.5 text-left hover:bg-surface-secondary"
                        >
                          <span className="min-w-0 flex-1 truncate text-label text-text-primary">
                            {localName(candidate, language)}
                          </span>
                          <span className="text-financial shrink-0 text-text-primary">
                            {formatMoney(candidate.price)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <ProductSearch
                  products={products}
                  language={language}
                  query={line.query}
                  onQueryChange={(query) => updateLine(line.key, { query })}
                  onPick={(product) => pickProduct(line.key, product)}
                />
              )}
            </section>
          ))}

          {/*
           * Only once the draft HAS one currency: before an item is chosen
           * there is nothing to type a fee in (the field used to say "USD"
           * for every empty draft), and a mixed draft has no single currency
           * a fee could be in.
           */}
          {realCustomer && priced ? (
            <DeliveryFeeField
              id="prepare-order-delivery-fee"
              value={deliveryFee.currency === priced.currency ? deliveryFee.text : ""}
              onChange={(text) => setDeliveryFee({ text, currency: priced.currency })}
              currency={priced.currency}
            />
          ) : null}

          {realCustomer ? (
            <div>
              <p className="text-label text-text-secondary">{t("shipping.title")}</p>
              <ShippingIntentSection
                idPrefix="prepare-order"
                intent={shipIntent}
                onIntentChange={setShipIntent}
                value={shipping}
                onChange={setShipping}
              />
            </div>
          ) : null}

          {/*
           * A total only for a draft that honestly has one. A mixed USD/KHR
           * draft gets an explanation instead — never a summed or converted
           * figure — and an empty draft shows no total at all.
           */}
          {priced ? (
            <div className="rounded-xl border border-border-default bg-surface-secondary p-3">
              {priced.deliveryFee.amount > 0 ? (
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span className="text-body-sm text-text-secondary">{t("order.deliveryFee")}</span>
                  <span className="text-data text-text-primary">
                    +{formatMoney(priced.deliveryFee)}
                  </span>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-x-3">
                <span className="text-label text-text-primary">
                  {t("conversation.prepareOrder.estimatedTotal")}
                </span>
                <span className="text-financial-lg min-w-0 break-all text-text-primary">
                  {formatMoney(priced.total)}
                </span>
              </div>
              <p className="text-caption mt-1 text-text-muted">
                {t("conversation.prepareOrder.estimatedNote")}
              </p>
            </div>
          ) : totals.kind === "mixed_currency" || totals.kind === "out_of_range" ? (
            <div role="alert" className="rounded-xl bg-status-danger-soft p-3">
              <p className="text-label text-status-danger-text">
                {t(
                  totals.kind === "mixed_currency"
                    ? "conversation.prepareOrder.currency.mixedTitle"
                    : "conversation.prepareOrder.currency.tooLargeTitle",
                )}
              </p>
              <p className="text-body-sm mt-1 text-text-primary">
                {t(
                  totals.kind === "mixed_currency"
                    ? "conversation.prepareOrder.currency.mixedBody"
                    : "conversation.prepareOrder.currency.tooLargeBody",
                )}
              </p>
            </div>
          ) : null}

          {/*
           * A refusal, not a failure: APSA cannot turn this draft into a real
           * order, so it says which thing is in the way and offers no retry —
           * retrying changes nothing until the merchant fixes the catalog or
           * the conversation. What it must never do is fall through to a
           * fabricated order code, which is what this branch replaced.
           */}
          {blocker ? (
            <div className="space-y-2">
              <ErrorState
                title={t("conversation.prepareOrder.unsellable.title")}
                body={t(`conversation.prepareOrder.unsellable.${blocker}`)}
                className="py-4"
              />
              {blocker === "no-variant" ? (
                <ul className="space-y-1">
                  {readyLinesForDisplay
                    .filter((line) => !line.product.variantId)
                    .map((line) => (
                      <li key={line.key} className="flex justify-between gap-2">
                        <span className="text-body-sm min-w-0 truncate text-text-primary">
                          {localName(line.product, language)}
                        </span>
                        <span className="text-caption shrink-0 text-status-danger-text">
                          {t("conversation.prepareOrder.unsellable.noVariantLine")}
                        </span>
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {failure ? (
            <ErrorState
              title={t(`${failureCopy}.title`)}
              body={t(`${failureCopy}.body`)}
              {...(failure === "currency" ? {} : { onRetry: () => void submit() })}
              className="py-4"
            />
          ) : null}
        </fieldset>
      ) : step.name === "created-mock" ? (
        <CreatedCelebration code={step.order.code} />
      ) : (
        <div className="space-y-5 pb-4">
          <CreatedCelebration code={step.detail.order.code} />

          {failure ? (
            <ErrorState
              title={t(
                failure === "permission"
                  ? "conversation.prepareOrder.permission.title"
                  : "conversation.prepareOrder.error.title",
              )}
              body={t(
                failure === "permission"
                  ? "conversation.prepareOrder.permission.body"
                  : "conversation.prepareOrder.error.body",
              )}
              className="py-2"
            />
          ) : null}

          {step.detail.order.lifecycleStatus === "confirmed" ? (
            <p className="text-body text-center text-text-secondary">
              {t("conversation.prepareOrder.confirmed")}
            </p>
          ) : (
            <Button
              className="tap-target h-12 w-full"
              // Either draft operation in flight blocks the other (see "Draft operations").
              disabled={operation !== null}
              aria-busy={operation === "confirm"}
              onClick={() => void confirm()}
            >
              {operation === "confirm"
                ? t("conversation.prepareOrder.confirming")
                : t("conversation.prepareOrder.confirmOrder")}
            </Button>
          )}

          <div className="flex gap-2">
            {step.detail.order.lifecycleStatus !== "confirmed" ? (
              <button
                type="button"
                disabled={operation !== null}
                aria-busy={operation === "discard"}
                onClick={() => void discardAndEdit()}
                className="press tap-target text-label flex-1 rounded-full border border-border-default px-4 py-3 text-text-primary disabled:opacity-50"
              >
                {operation === "discard"
                  ? t("conversation.prepareOrder.discardingDraft")
                  : t("conversation.prepareOrder.discardDraft")}
              </button>
            ) : null}
            <a
              href={`/app/orders/${step.detail.order.id}`}
              className="press tap-target text-label flex-1 rounded-full border border-border-default px-4 py-3 text-center text-text-primary"
            >
              {t("conversation.prepareOrder.viewOrder")}
            </a>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

function CreatedCelebration({ code }: { code: string }) {
  const { t } = useTranslation();
  return (
    <motion.div
      className="flex flex-col items-center py-6 text-center"
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.42, ease: [0.34, 1.3, 0.64, 1] }}
      role="status"
    >
      <motion.span
        className="flex size-16 items-center justify-center rounded-full text-text-inverse"
        style={{ backgroundColor: "var(--companion-minto)" }}
        initial={{ scale: 0.6 }}
        animate={{ scale: [0.6, 1.12, 1] }}
        transition={{ duration: 0.5, ease: [0.34, 1.3, 0.64, 1] }}
      >
        <Check className="size-8" aria-hidden />
      </motion.span>
      <p className="text-h2 mt-4 text-text-primary">
        {t("conversation.prepareOrder.draftCreated", { code })}
      </p>
    </motion.div>
  );
}

interface ProductSearchProps {
  products: Product[];
  language: "km" | "en";
  query: string;
  onQueryChange: (query: string) => void;
  onPick: (product: Product) => void;
}

function ProductSearch({ products, language, query, onQueryChange, onPick }: ProductSearchProps) {
  const { t } = useTranslation();
  const q = query.trim().toLowerCase();
  const list = q
    ? products.filter(
        (p) =>
          p.nameEn.toLowerCase().includes(q) ||
          p.nameKm.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q),
      )
    : products;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t("conversation.prepareOrder.searchProducts")}
          aria-label={t("conversation.prepareOrder.searchProducts")}
          className="h-11 pl-9"
        />
      </div>
      <ul className="max-h-56 space-y-2 overflow-y-auto">
        {list.slice(0, 20).map((product) => (
          <li key={product.id}>
            <button
              type="button"
              onClick={() => onPick(product)}
              disabled={product.stock === 0}
              className="tap-target flex w-full items-center gap-3 rounded-xl border border-border-default bg-surface-primary px-3 py-2.5 text-left hover:bg-surface-secondary disabled:opacity-50"
            >
              <span className="min-w-0 flex-1">
                <span className="text-label block truncate text-text-primary">
                  {localName(product, language)}
                </span>
                <span className="text-caption tnum block truncate text-text-muted">
                  {product.sku}
                </span>
              </span>
              <span className="text-financial shrink-0 text-text-primary">
                {formatMoney(product.price)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
