/**
 * Create-order flow for the production Order domain (Real Order UI
 * Integration phase). Reached from the real Order list (src/routes/app.orders.tsx).
 *
 * Every priced value shown here (subtotal/discount/total) is a CLIENT-SIDE
 * PREVIEW only, computed from the catalog price already on screen — never
 * sent to the server and never assumed to be the order's final total. The
 * server prices every line itself from product_variants and returns the
 * authoritative order (src/server/orders/service.ts); `onCreated` is called
 * with THAT order, not this preview.
 *
 * The preview is in the line's OWN currency — the chosen variant's price
 * currency — through the shared draft arithmetic (calculateDraftTotals), the
 * same rules the Inbox order sheets and POS use. There is no USD default: the
 * previous version seeded the discount with usd(0), so selecting any riel
 * product threw "Cannot subtract different currencies" and the sheet crashed.
 *
 * Client never supplies a price, a subtotal or a total, and never a member or
 * organization for the server to act as — createRealOrder()'s input
 * (src/lib/api/index.ts) has no field for any of them. The one identity it
 * sends is the refuse-only principal the attempt was started as, which the
 * server only compares with its own session-derived principal and refuses on
 * a mismatch (CORRECTIONS.md, CORRECTION-004). The discount and the delivery
 * fee are integer minor-unit INPUTS in that same currency, which the server
 * bounds and folds into the total itself (create_order_v3).
 *
 * Retry safety: every submit of the same request sends the same idempotency
 * key (src/lib/idempotency.ts), so a retry after a lost response returns the
 * order the first attempt created instead of a second one.
 */
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet, QuantityStepper } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { DeliveryFeeField } from "@/components/orders/DeliveryFeeField";
import { ShippingIntentSection } from "@/components/orders/ShippingIntentSection";
import {
  type ShippingDestinationValue,
  EMPTY_SHIPPING_DESTINATION,
  orderShippingPayload,
  shippingIntentReady,
} from "@/lib/shipping-destination";
import { useCapabilities } from "@/hooks/use-capabilities";
import {
  createRealOrder,
  getProducts,
  listRealCustomers,
  searchRealCustomers,
  type OrderCustomerOption,
} from "@/lib/api";
import { classifyOrderError, isOrderCurrencyMismatch } from "@/lib/orders";
import { createScopedIdempotencyHolders } from "@/lib/idempotency";
import { catalogKeys } from "@/lib/catalog";
import { customerKeys, visibleCustomerPhone } from "@/lib/customers-query";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { formatMoney, MINOR_UNIT_DIGITS } from "@/lib/money";
import {
  calculateDraftTotals,
  defaultProductVariantId,
  draftBlock,
  needsVariantChoice,
  NO_DELIVERY_FEE,
  productVariantPrice,
  type DraftDeliveryFee,
} from "@/lib/order-draft";
import { discountProblemKey, NO_DISCOUNT, type CartDiscountInput } from "@/lib/pos-cart";
import { cn } from "@/lib/utils";
import type { Order, Product } from "@/types";

type OrderSourceDb = "POS" | "FACEBOOK" | "INSTAGRAM" | "TELEGRAM" | "MANUAL";

const SOURCES: OrderSourceDb[] = ["POS", "FACEBOOK", "INSTAGRAM", "TELEGRAM", "MANUAL"];

const SOURCE_LABEL_KEY: Record<OrderSourceDb, string> = {
  POS: "channel.pos",
  FACEBOOK: "channel.facebook",
  INSTAGRAM: "channel.instagram",
  TELEGRAM: "channel.telegram",
  MANUAL: "order.sourceManual",
};

const chipClass = "tap-target rounded-full border px-4 text-label transition-colors";

interface CreateRealOrderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (order: Order) => void;
  /**
   * The signed-in principal, from the /app route guard's server-derived
   * context. Cache identity for the two reads below and nothing else — the
   * server resolves both values itself and re-authorizes every call.
   */
  userId: string;
  organizationId: string;
}

export function CreateRealOrderSheet({
  open,
  onOpenChange,
  onCreated,
  userId,
  organizationId,
}: CreateRealOrderSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const capabilities = useCapabilities();

  const [productQuery, setProductQuery] = useState("");
  const [product, setProduct] = useState<Product | null>(null);
  /*
   * The ACTIVE variant this order will actually be placed against.
   *
   * `mapServerProductToUi` sets `product.variantId` to whichever ACTIVE
   * variant the server returned FIRST, and exposes the full list as
   * `productionVariants` precisely so that a multi-variant product is never
   * sold on that guess. This sheet used to submit `product.variantId`
   * unconditionally — the same wrong-variant defect already fixed in
   * PosVariantSheet and PrepareOrderSheet. Null on a multi-variant product
   * means "the merchant has not chosen yet" and blocks submit; there is no
   * fallback to the first variant anywhere below.
   */
  const [variantId, setVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [source, setSource] = useState<OrderSourceDb>("POS");
  /*
   * Discount and delivery fee are kept as the text the merchant typed plus the
   * currency it was typed for, and parsed in the line's currency on every
   * render (dollars-and-cents for USD, whole riel for KHR). The discount used
   * to be a USD-only CurrencyInput (floating-point dollars turned into cents)
   * applied as usd(...) whatever the product's currency.
   */
  const [discount, setDiscount] = useState<CartDiscountInput>(NO_DISCOUNT);
  const [deliveryFee, setDeliveryFee] = useState<DraftDeliveryFee>(NO_DELIVERY_FEE);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customer, setCustomer] = useState<OrderCustomerOption | null>(null);
  /*
   * Optional order shipping destination — the parcel's authoritative
   * destination, snapshotted onto the order at creation (§13). Left blank for an
   * in-store pickup order. Selecting a customer prefills the recipient
   * name/phone as a convenience; the address is always the merchant's to enter,
   * since the customer's on-file address is not the order's destination truth.
   */
  const [shipping, setShipping] = useState<ShippingDestinationValue>(EMPTY_SHIPPING_DESTINATION);
  // Shipping is an explicit choice — a chosen customer's prefilled name/phone
  // never turn a pickup order into a shipment.
  const [shipIntent, setShipIntent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<"permission" | "currency" | "generic" | null>(null);
  const [created, setCreated] = useState<Order | null>(null);
  /*
   * `submitting` state alone does not block a second tap fired in the same
   * event tick, before React re-renders the disabled button — the exact bug
   * class already fixed in PosCheckoutSheet.completeReal() via this same
   * ref, checked synchronously before any await.
   */
  const submittingRef = useRef(false);

  /*
   * ── Session identity ─────────────────────────────────────────────────────
   *
   * Every open of this sheet is one SESSION, for one member of one
   * organization, and every submit within it one ATTEMPT. A create can outlive
   * its session: the merchant closes the sheet while it is pending and opens a
   * new one, the member or organization changes under it, or the Orders list
   * unmounts. Its late response used to write unconditionally — a create for
   * product A resolving after close → reopen → product B painted "Order A
   * created" over B's draft (B was never created), a late failure showed in
   * B's session, and the late attempt's `finally` released B's submit guard.
   *
   * Every attempt now carries a token: its session, its attempt number, and the
   * member and organization it was sent as. Its response is applied only while
   * that token is current; a stale one returns without touching state,
   * onCreated, the submit guard or the replay key. The server's answer stays
   * authoritative — nothing here cancels or undoes an order it created; that
   * order is in Orders, and an identical resubmission is answered with it — the
   * browser just never applies it to a session that did not ask for it.
   *
   * sessionRef moves on whenever a session ends: reset() (closed by its own
   * control or by the parent, or the member/organization changed) and unmount.
   * Within a session the draft is locked while an attempt is pending (the
   * <fieldset> below), so the request cannot change under it.
   */
  const sessionRef = useRef(0);
  const attemptRef = useRef(0);
  /** The member and organization the open session belongs to. */
  const principalRef = useRef({ userId, organizationId });

  interface AttemptToken {
    session: number;
    attempt: number;
    userId: string;
    organizationId: string;
  }

  function beginAttempt(): AttemptToken {
    attemptRef.current += 1;
    return { session: sessionRef.current, attempt: attemptRef.current, userId, organizationId };
  }

  function isCurrent(token: AttemptToken): boolean {
    const principal = principalRef.current;
    return (
      token.session === sessionRef.current &&
      token.attempt === attemptRef.current &&
      token.userId === principal.userId &&
      token.organizationId === principal.organizationId
    );
  }

  /*
   * One replay key per logical order attempt (src/lib/idempotency.ts). It
   * survives a failed submit and a sheet close, so re-sending the same request —
   * even from a reopened sheet — can only ever replay the order that request
   * created.
   *
   * Each attempt takes its own CLAIM on the key and retires it only once this
   * sheet ACCEPTS the response (after isCurrent) — never on arrival. A dropped
   * late success therefore leaves the key held, so the identical order rebuilt
   * after reopening is answered with the order the server already made rather
   * than a second one, and a stale claim can never retire a key a newer
   * attempt owns. Once a response is accepted the key is retired, so the next
   * order — even an identical one — is new.
   *
   * The sheet stays mounted while the member or organization changes, so it
   * keeps one holder PER member + organization (createScopedIdempotencyHolders)
   * rather than one for its lifetime. No key or claim crosses into another
   * principal — and switching away no longer discards one: replacing the holder
   * on every switch turned "lost response in A → B → back to A → the identical
   * order" into a second order. A's unresolved key is waiting for A's rebuild.
   * The holder is looked up at each attempt, as the principal the request is
   * sent as.
   */
  const replayHolders = useRef(createScopedIdempotencyHolders());
  const idempotencyKeys = {
    claim: () =>
      replayHolders.current
        // No subject: one New Order flow per member and organization.
        .holderFor({ userId, organizationId, flow: "orders-new-order", subject: "" })
        .claim(),
  };

  /*
   * Both reads are organization data — the catalog with its prices, and a
   * customer list whose `phone` the server PII-gates per member. They were
   * keyed on `["order-create", ...]` with no principal at all, so a picker
   * opened by the next member to use this tab could be filled from the
   * previous one's cache. Each now lives in its own domain's partition.
   */
  const canSensitive = capabilities.canSensitive("customers.view_sensitive");

  const productsQuery = useQuery({
    queryKey: catalogKeys.uiProducts(userId, organizationId, "order-create"),
    queryFn: getProducts,
    enabled: open,
  });
  /*
   * Two reads, because they answer two different questions.
   *
   * With no query typed, the picker offers a short recent list — one bounded
   * page, presented as exactly that.
   *
   * The moment something is typed, the SERVER searches, across the whole
   * tenant. This is the launch defect being fixed: the sheet used to filter
   * that single bounded page in the browser, so a customer past it could not
   * be picked and the sheet said "no customers" about someone who exists.
   */
  const customersQuery = useQuery({
    queryKey: customerKeys.options(userId, organizationId),
    queryFn: listRealCustomers,
    enabled: open && customerQuery.trim().length === 0,
  });

  const customerSearch = useQuery({
    queryKey: customerKeys.search(userId, organizationId, customerQuery.trim(), canSensitive),
    /*
     * `canSensitive` is not an access decision here — the server re-derives
     * the grant from the caller's membership and would refuse regardless. It
     * stops a phone-shaped query from a member without the grant being SENT at
     * all. It is also in the cache key above, because a result set matched
     * against real phone numbers is a different answer to the same term than
     * one matched without them, and must never be served back after the grant
     * is revoked.
     */
    queryFn: () => searchRealCustomers(customerQuery.trim(), canSensitive),
    enabled: open && customerQuery.trim().length > 0,
  });

  const productList = useMemo(() => {
    const all = productsQuery.data ?? [];
    const q = productQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.nameEn.toLowerCase().includes(q) ||
        p.nameKm.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q),
    );
  }, [productsQuery.data, productQuery]);

  /*
   * Masked against the CURRENT grant before anything reads the phone —
   * including the search filter below.
   *
   * Masking before filtering matters on its own: matching a typed phone
   * fragment against a number this member may no longer see would answer
   * "does a customer with this number exist here?" without ever displaying it.
   * With the value already blanked, the filter cannot answer that question.
   */
  const searching = customerQuery.trim().length > 0;
  const searchPage = customerSearch.data;

  /*
   * Masked against the CURRENT grant before anything renders it. The search
   * itself can no longer match on a hidden number — the server refuses to read
   * the phone column without the grant — so this is defence in depth over the
   * displayed value, and it is what makes a phone disappear on the very next
   * render after a revocation rather than on the next refetch.
   */
  const customerList = useMemo(() => {
    const rows: OrderCustomerOption[] = searching
      ? (searchPage?.customers ?? []).map((c) => ({
          id: c.id,
          nameKm: c.nameKm,
          nameEn: c.nameEn,
          phone: c.phone,
          sensitiveVisible: c.sensitiveVisible ?? false,
        }))
      : (customersQuery.data ?? []);
    return rows.map((c) => ({ ...c, phone: visibleCustomerPhone(c, canSensitive) }));
  }, [searching, searchPage, customersQuery.data, canSensitive]);

  /*
   * Three negatives that must stay three sentences. "No customer matched" is a
   * claim about the tenant; "you may not search by phone" is a claim about
   * this member and says nothing at all about the tenant; "there are more"
   * says the list on screen is not the answer. Merging any two of them is how
   * a real customer gets reported as not existing.
   */
  const phoneDenied = searching && searchPage?.phoneSearchDenied === true;
  const searchIncomplete = Boolean(searchPage && (searchPage.hasMore || searchPage.truncated));
  /*
   * `!searchIncomplete` stops the two lines contradicting each other. A
   * bounded phone scan that read part of a large tenant and matched nothing
   * used to render "no customers matched" AND "more customers match than are
   * shown" together — one of which is false and the other unreadable next to
   * it. An incomplete search with no matches is searchBounded below, alone.
   */
  const searchEmpty =
    searching &&
    !phoneDenied &&
    customerSearch.isSuccess &&
    customerList.length === 0 &&
    !searchIncomplete;

  /** Searched, matched nothing, stopped early. Never presented as absence. */
  const searchBounded =
    searching &&
    !phoneDenied &&
    customerSearch.isSuccess &&
    customerList.length === 0 &&
    searchIncomplete;
  const listEmpty = !searching && customersQuery.isSuccess && customerList.length === 0;

  /*
   * Selecting (or changing) a product must never carry the previous product's
   * variant choice over — a stale variantId would submit a variant that
   * belongs to a different product entirely. Single-variant products resolve
   * themselves here; multi-variant ones reset to unchosen.
   */
  function selectProduct(next: Product | null) {
    setProduct(next);
    setVariantId(defaultProductVariantId(next));
  }

  /*
   * Prefill the shipping recipient from the chosen customer as a convenience
   * (dormant unless the merchant turns shipping on), but only into blank fields so a merchant's own edits are never overwritten.
   * The address is deliberately never prefilled from the customer profile — the
   * order's destination is the merchant's to confirm, not the mutable default.
   */
  function selectCustomer(next: OrderCustomerOption) {
    setCustomer(next);
    setShipping((prev) => ({
      ...prev,
      name: prev.name.trim() ? prev.name : localName(next, language),
      phone: prev.phone.trim() ? prev.phone : (next.phone ?? ""),
    }));
  }

  const mustChooseVariant = needsVariantChoice(product);
  const activeVariants = product?.productionVariants ?? [];
  const selectedVariant = activeVariants.find((v) => v.variantId === variantId) ?? null;
  /** The chosen variant's own price — never the product's first-variant price. */
  const unitPrice = product ? productVariantPrice(product, variantId) : null;

  /*
   * The order's currency is its line's: the chosen variant's price currency.
   * A discount or fee belongs to the currency it was typed for, so a change of
   * currency — another product, or a variant priced in the other currency —
   * CLEARS both (adjusted during render, so no frame shows "5" re-read as ៛5),
   * rather than keeping them to reappear when the currency changes back.
   */
  const currency = unitPrice?.currency ?? null;
  const [moneyContext, setMoneyContext] = useState(currency);
  if (moneyContext !== currency) {
    setMoneyContext(currency);
    setDiscount(NO_DISCOUNT);
    setDeliveryFee(NO_DELIVERY_FEE);
  }

  /*
   * One line, priced in its own currency. A malformed or over-subtotal
   * discount and an invalid fee are reported (and block submit) — never
   * coerced into some other amount, and a discount is never clamped down to
   * the subtotal: the server refuses discount_exceeds_subtotal too.
   */
  const totals = calculateDraftTotals(
    unitPrice ? [{ unitPrice, quantity }] : [],
    discount,
    deliveryFee,
  );
  const priced = totals.kind === "priced" ? totals : null;
  const moneyBlock = draftBlock(totals);

  function reset() {
    // The session ends here: whatever is still in flight belonged to it, not
    // to whatever opens next.
    sessionRef.current += 1;
    setProductQuery("");
    setProduct(null);
    setVariantId(null);
    setQuantity(1);
    setSource("POS");
    setDiscount(NO_DISCOUNT);
    setDeliveryFee(NO_DELIVERY_FEE);
    setCustomerQuery("");
    setCustomer(null);
    setShipping(EMPTY_SHIPPING_DESTINATION);
    setShipIntent(false);
    setSubmitting(false);
    setFailure(null);
    setCreated(null);
    submittingRef.current = false;
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  /*
   * However a session ends, it ends in reset(): the sheet's own close control
   * (above), the parent setting `open` to false, or a different member or
   * organization — which is a different New Order: nothing this session holds
   * (its draft, an attempt in flight) belongs to it. The replay key is not the
   * session's: it stays with its member + organization's holder (above),
   * unreachable from the new principal, for when the switch comes back. These
   * are LAYOUT effects so they run in the same commit as the change; no
   * response can resolve in between and be taken for the new session's.
   */
  const resetRef = useRef(reset);
  useLayoutEffect(() => {
    resetRef.current = reset;
  });
  useLayoutEffect(() => {
    if (!open) resetRef.current();
  }, [open]);
  useLayoutEffect(() => {
    const principal = principalRef.current;
    if (principal.userId === userId && principal.organizationId === organizationId) return;
    principalRef.current = { userId, organizationId };
    resetRef.current();
  }, [userId, organizationId]);
  useEffect(
    () => () => {
      // Unmounted (e.g. the Orders list navigated away): whatever is still in
      // flight has no session left to update.
      sessionRef.current += 1;
    },
    [],
  );

  /*
   * Submit is impossible without a resolved variant. For a multi-variant
   * product that means an EXPLICIT choice; `product.variantId` is deliberately
   * not consulted here, so restoring it would fail the regression tests.
   */
  const shippingReady = shippingIntentReady(shipIntent, shipping);
  const orderInputsReady = moneyBlock === null && shippingReady;
  const readyToSubmit = Boolean(product) && Boolean(variantId) && orderInputsReady;

  async function submit() {
    if (!product || !variantId) return;
    if (!priced || moneyBlock !== null || !shippingReady) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    // Integer minor units in the line's own currency — the only money sent.
    const discountMinor = priced.discount.amount;
    const deliveryMinor = priced.deliveryFee.amount;
    // This attempt's place in this session, and its own claim on the replay key
    // of the member and organization it is sent as.
    const token = beginAttempt();
    const claim = idempotencyKeys.claim();
    try {
      const shippingPayload = orderShippingPayload(shipIntent, shipping);
      const detail = await createRealOrder({
        source,
        items: [{ variantId, quantity, productId: product.id }],
        customerId: customer?.id ?? null,
        ...(discountMinor > 0 ? { discountMinor } : {}),
        ...(deliveryMinor > 0 ? { deliveryMinor } : {}),
        ...(shippingPayload ? { shipping: shippingPayload } : {}),
        idempotency: claim,
        /*
         * The principal this attempt was started as — the one its token and its
         * replay claim belong to. The server derives who is acting only when it
         * handles the request, after the lazy import and the trip; if the member
         * or the organization changed in between (here, or in another tab), it
         * refuses instead of creating this order as someone else, and writes
         * nothing — so this principal's retry still owns the key.
         */
        principal: { userId: token.userId, organizationId: token.organizationId },
      });
      // Abandoned (closed, reopened, member or organization switched,
      // unmounted): the order may exist server-side, but this is no longer the
      // session that asked for it. Its key is NOT retired — an identical
      // request rebuilt later is answered with this same order.
      if (!isCurrent(token)) return;
      // Accepted: the next order — even an identical one — gets a new key.
      claim.retire();
      /*
       * The order is real from here on, so the list is told immediately
       * rather than after a timer — and the sheet stays open on a confirmation
       * the merchant can act from. It previously auto-closed after 1100ms,
       * which showed a code and then took it away: no way to open the order
       * that had just been created, and no next step toward payment.
       */
      setCreated(detail.order);
      onCreated(detail.order);
    } catch (error) {
      // A failure belongs to its own session too, never to a newer one.
      if (!isCurrent(token)) return;
      /*
       * The server prices an order in the organization's one currency and
       * refuses a variant priced in another (currency_mismatch). Retrying can
       * never succeed, so that refusal is named — the same copy as the Inbox
       * order sheet — and offers no retry.
       */
      setFailure(
        isOrderCurrencyMismatch(error)
          ? "currency"
          : classifyOrderError(error) === "forbidden"
            ? "permission"
            : "generic",
      );
    } finally {
      // Only the live attempt releases the guard: reset() already released it
      // for an abandoned one, and a newer session may hold it now.
      if (isCurrent(token)) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={created ? undefined : t("orderCreate.title")}
      snap="full"
      className="lg:max-w-[520px]"
      /*
       * Pinned rather than the last thing in the scrollable body. The order
       * line now carries a variant picker on top of source chips, quantity,
       * discount, customer search and the totals card — more than enough to
       * push an inline CTA off a 320/360px screen, and the customer field's
       * own scroll-into-view on focus could hide it behind the keyboard. Same
       * fix, same slot, as PrepareOrderSheet. Only this step needs it: the
       * product search step scrolls its own list and the created step is a
       * short confirmation whose actions were never at risk.
       */
      footer={
        !created && product ? (
          <div>
            <Button
              className="tap-target h-12 w-full"
              disabled={!readyToSubmit || submitting}
              onClick={() => void submit()}
            >
              {submitting ? t("orderCreate.creating") : t("orderCreate.submit")}
            </Button>
            {!variantId ? (
              <p className="text-caption mt-2 text-center text-text-muted">
                {t("orderCreate.chooseVariantFirst")}
              </p>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {created ? (
        <motion.div
          className="flex flex-col items-center py-10 text-center"
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
            {t("orderCreate.created", { code: created.code })}
          </p>
          <p className="text-body mt-1 text-text-secondary">{t("orderCreate.createdBody")}</p>
          {/*
           * The order's own payment axis, straight from the server — never
           * inferred from the fact that creation succeeded.
           */}
          <p className="text-body-sm mt-2 text-text-secondary">
            {t(`status.${created.paymentStatus}`)}
          </p>
          <div className="mt-6 w-full space-y-2">
            <a
              href={`/app/orders/${created.id}`}
              className="press tap-target text-label elevation-action flex w-full items-center justify-center rounded-full bg-action-primary px-4 py-3 text-text-on-action"
            >
              {t("orderCreate.viewOrder")}
            </a>
            <Button
              variant="outline"
              className="tap-target w-full"
              onClick={() => handleOpenChange(false)}
            >
              {t("orderCreate.done")}
            </Button>
          </div>
        </motion.div>
      ) : product && unitPrice ? (
        /*
         * The whole draft is inert while its create is in flight: the request
         * was built from these values, so editing them under it would leave the
         * merchant looking at an order that is not the one being created. (The
         * footer button is outside, and already disabled; closing the sheet
         * stays possible, and ends the session.)
         */
        <fieldset disabled={submitting} className="m-0 min-w-0 space-y-5 border-0 p-0 pb-4">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-caption text-text-muted">{t("orderCreate.product")}</p>
              <p className="chip-text text-h3 text-text-primary">{localName(product, language)}</p>
              <p className="text-data text-text-muted">{selectedVariant?.sku ?? product.sku}</p>
              {/* The variant this line will actually be placed against, once chosen. */}
              {selectedVariant ? (
                <p className="text-body-sm text-text-secondary">{selectedVariant.name}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => selectProduct(null)}
              className="tap-target text-label shrink-0 px-2 text-action-primary"
            >
              {t("orderCreate.change")}
            </button>
          </div>

          {/*
           * Explicit variant choice for a multi-variant product. Rendered in
           * the order line itself (directly under the product it belongs to),
           * ACTIVE variants only — `productionVariants` is built server-side
           * from a `status = "ACTIVE"` query, so an archived SKU never
           * appears here and cannot be chosen. Name and price are both shown
           * because a real variant has no attribute matrix, only a free-text
           * name ("Red / L") that is the merchant's one way to tell two SKUs
           * apart. Same markup as PosVariantSheet and PrepareOrderSheet: one
           * full-width row per variant, so a long Khmer variant name wraps
           * into the row rather than being clipped at 320px.
           */}
          {mustChooseVariant ? (
            <div>
              <p className="text-label text-text-secondary">{t("pos.variant.chooseOne")}</p>
              <ul className="mt-2 space-y-2">
                {activeVariants.map((v) => {
                  const selected = v.variantId === variantId;
                  return (
                    <li key={v.variantId}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setVariantId(v.variantId)}
                        className={cn(
                          "tap-target flex w-full items-center gap-3 rounded-xl border px-4 py-2.5 text-left transition-colors",
                          selected
                            ? "border-action-primary bg-action-primary-soft text-action-primary"
                            : "border-border-strong bg-surface-primary text-text-primary",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="chip-text text-label block">{v.name}</span>
                          <span className="text-caption tnum block truncate text-text-muted">
                            {v.sku}
                          </span>
                        </span>
                        <span className="text-financial shrink-0">{formatMoney(v.price)}</span>
                        {selected ? (
                          <Check className="size-4 shrink-0 text-action-primary" aria-hidden />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <fieldset>
            <legend className="text-label text-text-secondary">{t("orderCreate.source")}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {SOURCES.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={source === value}
                  onClick={() => setSource(value)}
                  className={cn(
                    chipClass,
                    source === value
                      ? "border-action-primary bg-action-primary text-text-on-action"
                      : "border-border-strong bg-surface-primary text-text-primary",
                  )}
                >
                  <span className="chip-text">{t(SOURCE_LABEL_KEY[value])}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="flex items-center justify-between gap-3">
            <span className="text-label text-text-secondary">{t("orderCreate.quantity")}</span>
            <QuantityStepper value={quantity} onChange={setQuantity} />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-label text-text-secondary">{t("orderCreate.unitPrice")}</span>
            <span className="text-financial text-text-primary">{formatMoney(unitPrice)}</span>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-label text-text-secondary">{t("orderCreate.discount")}</span>
              <button
                type="button"
                role="switch"
                aria-checked={discount.enabled}
                aria-label={t("orderCreate.discount")}
                onClick={() =>
                  setDiscount((d) => ({
                    ...d,
                    enabled: !d.enabled,
                    text: "",
                    currency: unitPrice.currency,
                  }))
                }
                className={cn(
                  "tap-target flex w-14 items-center rounded-full px-1",
                  discount.enabled ? "bg-action-primary" : "bg-surface-secondary",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-6 rounded-full bg-surface-primary shadow transition-transform",
                    discount.enabled ? "translate-x-6" : "translate-x-0",
                  )}
                />
              </button>
            </div>
            {/*
             * An amount in the line's currency, typed and parsed the way
             * DeliveryFeeField below is: the currency is fixed (a picker would
             * be an implicit conversion), and riel takes whole numbers only.
             */}
            {discount.enabled ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="order-create-discount" className="text-label text-text-secondary">
                  {t("pos.discount.amountIn", { currency: unitPrice.currency })}
                </Label>
                <Input
                  id="order-create-discount"
                  inputMode={MINOR_UNIT_DIGITS[unitPrice.currency] === 0 ? "numeric" : "decimal"}
                  autoComplete="off"
                  className="text-financial h-12"
                  value={discount.currency === unitPrice.currency ? discount.text : ""}
                  placeholder={MINOR_UNIT_DIGITS[unitPrice.currency] === 0 ? "0" : "0.00"}
                  aria-invalid={priced?.discountProblem ? true : undefined}
                  aria-describedby={
                    priced?.discountProblem ? "order-create-discount-error" : undefined
                  }
                  onChange={(event) =>
                    setDiscount((d) => ({
                      ...d,
                      text: event.target.value,
                      currency: unitPrice.currency,
                    }))
                  }
                />
                {priced?.discountProblem ? (
                  <p
                    id="order-create-discount-error"
                    role="alert"
                    className="text-caption text-status-danger-text"
                  >
                    {t(discountProblemKey(priced.discountProblem, discount.mode, priced.currency))}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <DeliveryFeeField
            id="order-create-delivery-fee"
            value={deliveryFee.currency === unitPrice.currency ? deliveryFee.text : ""}
            onChange={(text) => setDeliveryFee({ text, currency: unitPrice.currency })}
            currency={unitPrice.currency}
          />

          <div>
            <p className="text-label text-text-secondary">{t("orderCreate.customer")}</p>
            {customer ? (
              <button
                type="button"
                onClick={() => setCustomer(null)}
                className="tap-target mt-2 flex w-full items-center justify-between rounded-xl border border-action-primary bg-action-primary-soft px-4 py-2.5 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-label block truncate text-text-primary">
                    {localName(customer, language)}
                  </span>
                  <span className="text-caption tnum block truncate text-text-muted">
                    {customer.phone || t("orderCreate.noPhone")}
                  </span>
                </span>
                <span className="text-label shrink-0 text-action-primary">
                  {t("orderCreate.change")}
                </span>
              </button>
            ) : (
              <div className="mt-2 space-y-2">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
                    aria-hidden
                  />
                  <Input
                    value={customerQuery}
                    onChange={(e) => setCustomerQuery(e.target.value)}
                    placeholder={t("orderCreate.searchCustomers")}
                    aria-label={t("orderCreate.searchCustomers")}
                    className="h-11 pl-9"
                  />
                </div>
                {phoneDenied ? (
                  <p className="text-caption text-text-muted">
                    {t("orderCreate.phoneSearchDenied")}
                  </p>
                ) : null}
                {customerSearch.isError ? (
                  <p className="text-caption text-status-danger-text">
                    {t("orderCreate.customerSearchError")}
                  </p>
                ) : null}
                {searchEmpty ? (
                  <p className="text-caption text-text-muted">{t("orderCreate.noCustomers")}</p>
                ) : null}
                {searchBounded ? (
                  <p className="text-caption text-text-muted">
                    {t("orderCreate.boundedCustomers")}
                  </p>
                ) : null}
                {listEmpty ? (
                  <p className="text-caption text-text-muted">{t("orderCreate.customerNone")}</p>
                ) : null}
                {customerList.length > 0 ? (
                  <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                    {customerList.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => selectCustomer(c)}
                          className="tap-target flex w-full items-center justify-between rounded-xl border border-border-default bg-surface-primary px-3 py-2 text-left hover:bg-surface-secondary"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="text-label block truncate text-text-primary">
                              {localName(c, language)}
                            </span>
                            <span className="text-caption tnum block truncate text-text-muted">
                              {c.phone || t("orderCreate.noPhone")}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {/*
                 * Never let a page read as the whole tenant. Without this the
                 * merchant sees twenty names and concludes the twenty-first
                 * does not exist.
                 */}
                {searching && searchIncomplete && customerList.length > 0 ? (
                  <p className="text-caption text-text-muted">{t("orderCreate.moreCustomers")}</p>
                ) : null}
                {!searching && customerList.length > 0 ? (
                  <p className="text-caption text-text-muted">
                    {t("orderCreate.customerRecentHint")}
                  </p>
                ) : null}
              </div>
            )}
          </div>

          <div>
            <p className="text-label text-text-secondary">{t("shipping.title")}</p>
            <ShippingIntentSection
              idPrefix="order-create"
              intent={shipIntent}
              onIntentChange={setShipIntent}
              value={shipping}
              onChange={setShipping}
            />
          </div>

          {priced ? (
            <div className="rounded-xl border border-border-default bg-surface-secondary p-3">
              <div className="flex items-center justify-between">
                <span className="text-body-sm text-text-secondary">
                  {t("orderCreate.subtotal")}
                </span>
                <span className="text-data text-text-primary">{formatMoney(priced.subtotal)}</span>
              </div>
              {priced.discount.amount > 0 ? (
                <div className="flex items-center justify-between">
                  <span className="text-body-sm text-text-secondary">
                    {t("orderCreate.discount")}
                  </span>
                  <span className="text-data text-text-primary">
                    -{formatMoney(priced.discount)}
                  </span>
                </div>
              ) : null}
              {priced.deliveryFee.amount > 0 ? (
                <div className="flex items-center justify-between">
                  <span className="text-body-sm text-text-secondary">{t("order.deliveryFee")}</span>
                  <span className="text-data text-text-primary">
                    +{formatMoney(priced.deliveryFee)}
                  </span>
                </div>
              ) : null}
              <div className="mt-2 flex items-end justify-between border-t border-border-default pt-2">
                <span className="text-label text-text-primary">{t("orderCreate.total")}</span>
                <span className="text-financial-lg text-text-primary">
                  {formatMoney(priced.total)}
                </span>
              </div>
              <p className="text-caption mt-1 text-text-muted">{t("orderCreate.totalNote")}</p>
            </div>
          ) : totals.kind === "out_of_range" ? (
            // No inexact total is ever shown (or submittable) for an amount
            // beyond exact integer range.
            <p role="alert" className="text-body-sm text-status-danger-text">
              {t("conversation.prepareOrder.currency.tooLargeBody")}
            </p>
          ) : null}

          {failure ? (
            <OperationalState
              tone="danger"
              title={t(
                failure === "permission"
                  ? "orderCreate.permission.title"
                  : failure === "currency"
                    ? "conversation.prepareOrder.currency.serverMismatch.title"
                    : "orderCreate.error.title",
              )}
              body={t(
                failure === "permission"
                  ? "orderCreate.permission.body"
                  : failure === "currency"
                    ? "conversation.prepareOrder.currency.serverMismatch.body"
                    : "orderCreate.error.body",
              )}
              {...(failure === "currency" ? {} : { onRetry: () => void submit() })}
            />
          ) : null}
        </fieldset>
      ) : (
        <section>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
              aria-hidden
            />
            <Input
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
              placeholder={t("orderCreate.searchProducts")}
              aria-label={t("orderCreate.searchProducts")}
              className="h-12 pl-9"
            />
          </div>

          {productsQuery.isPending ? (
            <div className="mt-3 space-y-2">
              <div className="h-14 w-full animate-pulse rounded-xl bg-surface-secondary" />
              <div className="h-14 w-full animate-pulse rounded-xl bg-surface-secondary" />
              <div className="h-14 w-full animate-pulse rounded-xl bg-surface-secondary" />
            </div>
          ) : null}

          {productsQuery.isError ? (
            <OperationalState
              tone="danger"
              title={t("orderCreate.error.title")}
              body={t("orderCreate.error.body")}
              onRetry={() => void productsQuery.refetch()}
              className="mt-4"
            />
          ) : null}

          {productsQuery.isSuccess && productList.length === 0 ? (
            <p className="text-body-sm mt-3 text-text-secondary">{t("orderCreate.noProducts")}</p>
          ) : null}

          <ul className="mt-2 space-y-2">
            {productList.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => selectProduct(item)}
                  disabled={!item.variantId && (item.productionVariants?.length ?? 0) === 0}
                  className="tap-target flex w-full items-center gap-3 rounded-xl border border-border-default bg-surface-primary px-3 py-2.5 text-left transition-colors hover:bg-surface-secondary disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-label block truncate text-text-primary">
                      {localName(item, language)}
                    </span>
                    <span className="text-caption tnum block truncate text-text-muted">
                      {item.sku}
                    </span>
                  </span>
                  <span className="text-financial shrink-0 text-text-primary">
                    {formatMoney(item.price)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </BottomSheet>
  );
}
