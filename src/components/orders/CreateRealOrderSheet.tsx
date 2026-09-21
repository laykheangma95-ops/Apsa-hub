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
 * Client never supplies organization_id, user_id, a price, a subtotal or a
 * total — createRealOrder()'s input (src/lib/api/index.ts) has no field for
 * any of them.
 */
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BottomSheet, CurrencyInput, QuantityStepper } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { useCapabilities } from "@/hooks/use-capabilities";
import {
  createRealOrder,
  getProducts,
  listRealCustomers,
  searchRealCustomers,
  type OrderCustomerOption,
} from "@/lib/api";
import { classifyOrderError } from "@/lib/orders";
import { catalogKeys } from "@/lib/catalog";
import { customerKeys, visibleCustomerPhone } from "@/lib/customers-query";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { formatMoney, multiplyMoney, subtractMoney, usd } from "@/lib/money";
import {
  defaultProductVariantId,
  needsVariantChoice,
  productVariantPrice,
} from "@/lib/order-draft";
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
  const [discountEnabled, setDiscountEnabled] = useState(false);
  const [discountCents, setDiscountCents] = useState(0);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customer, setCustomer] = useState<OrderCustomerOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<"permission" | "generic" | null>(null);
  const [created, setCreated] = useState<Order | null>(null);
  /*
   * `submitting` state alone does not block a second tap fired in the same
   * event tick, before React re-renders the disabled button — the exact bug
   * class already fixed in PosCheckoutSheet.completeReal() via this same
   * ref, checked synchronously before any await.
   */
  const submittingRef = useRef(false);

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

  const mustChooseVariant = needsVariantChoice(product);
  const activeVariants = product?.productionVariants ?? [];
  const selectedVariant = activeVariants.find((v) => v.variantId === variantId) ?? null;
  /** The chosen variant's own price — never the product's first-variant price. */
  const unitPrice = product ? productVariantPrice(product, variantId) : usd(0);
  const subtotal = multiplyMoney(unitPrice, Math.max(1, quantity));
  const discount =
    discountEnabled && discountCents > 0 ? usd(Math.min(discountCents, subtotal.amount)) : usd(0);
  const total = subtractMoney(subtotal, discount);

  function reset() {
    setProductQuery("");
    setProduct(null);
    setVariantId(null);
    setQuantity(1);
    setSource("POS");
    setDiscountEnabled(false);
    setDiscountCents(0);
    setCustomerQuery("");
    setCustomer(null);
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
   * Submit is impossible without a resolved variant. For a multi-variant
   * product that means an EXPLICIT choice; `product.variantId` is deliberately
   * not consulted here, so restoring it would fail the regression tests.
   */
  const readyToSubmit = Boolean(product) && Boolean(variantId);

  async function submit() {
    if (!product || !variantId) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const detail = await createRealOrder({
        source,
        items: [{ variantId, quantity, productId: product.id }],
        customerId: customer?.id ?? null,
        ...(discountEnabled && discount.amount > 0 ? { discountMinor: discount.amount } : {}),
      });
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
      setFailure(classifyOrderError(error) === "forbidden" ? "permission" : "generic");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
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
            {!readyToSubmit ? (
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
      ) : product ? (
        <section className="space-y-5 pb-4">
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
                aria-checked={discountEnabled}
                aria-label={t("orderCreate.discount")}
                onClick={() => setDiscountEnabled((v) => !v)}
                className={cn(
                  "tap-target flex w-14 items-center rounded-full px-1",
                  discountEnabled ? "bg-action-primary" : "bg-surface-secondary",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-6 rounded-full bg-surface-primary shadow transition-transform",
                    discountEnabled ? "translate-x-6" : "translate-x-0",
                  )}
                />
              </button>
            </div>
            {discountEnabled ? (
              <CurrencyInput
                id="order-create-discount"
                label={t("orderCreate.discount")}
                value={discountCents}
                onChange={setDiscountCents}
              />
            ) : null}
          </div>

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
                          onClick={() => setCustomer(c)}
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

          <div className="rounded-xl border border-border-default bg-surface-secondary p-3">
            <div className="flex items-center justify-between">
              <span className="text-body-sm text-text-secondary">{t("orderCreate.subtotal")}</span>
              <span className="text-data text-text-primary">{formatMoney(subtotal)}</span>
            </div>
            {discount.amount > 0 ? (
              <div className="flex items-center justify-between">
                <span className="text-body-sm text-text-secondary">
                  {t("orderCreate.discount")}
                </span>
                <span className="text-data text-text-primary">-{formatMoney(discount)}</span>
              </div>
            ) : null}
            <div className="mt-2 flex items-end justify-between border-t border-border-default pt-2">
              <span className="text-label text-text-primary">{t("orderCreate.total")}</span>
              <span className="text-financial-lg text-text-primary">{formatMoney(total)}</span>
            </div>
            <p className="text-caption mt-1 text-text-muted">{t("orderCreate.totalNote")}</p>
          </div>

          {failure ? (
            <OperationalState
              tone="danger"
              title={t(
                failure === "permission"
                  ? "orderCreate.permission.title"
                  : "orderCreate.error.title",
              )}
              body={t(
                failure === "permission" ? "orderCreate.permission.body" : "orderCreate.error.body",
              )}
              onRetry={() => void submit()}
            />
          ) : null}
        </section>
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
