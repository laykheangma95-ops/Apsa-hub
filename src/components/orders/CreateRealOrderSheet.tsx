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
import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BottomSheet, CurrencyInput, QuantityStepper } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import {
  createRealOrder,
  getProducts,
  listRealCustomers,
  type OrderCustomerOption,
} from "@/lib/api";
import { classifyOrderError } from "@/lib/orders";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { formatMoney, multiplyMoney, subtractMoney, usd } from "@/lib/money";
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
}

export function CreateRealOrderSheet({ open, onOpenChange, onCreated }: CreateRealOrderSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();

  const [productQuery, setProductQuery] = useState("");
  const [product, setProduct] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [source, setSource] = useState<OrderSourceDb>("POS");
  const [discountEnabled, setDiscountEnabled] = useState(false);
  const [discountCents, setDiscountCents] = useState(0);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customer, setCustomer] = useState<OrderCustomerOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<"permission" | "generic" | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  const productsQuery = useQuery({
    queryKey: ["order-create", "products"],
    queryFn: getProducts,
    enabled: open,
  });
  const customersQuery = useQuery({
    queryKey: ["order-create", "customers"],
    queryFn: listRealCustomers,
    enabled: open,
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

  const customerList = useMemo(() => {
    const all = customersQuery.data ?? [];
    const q = customerQuery.trim().toLowerCase();
    const matches = !q
      ? all
      : all.filter(
          (c) =>
            c.nameEn.toLowerCase().includes(q) ||
            c.nameKm.toLowerCase().includes(q) ||
            c.phone.replace(/\s/g, "").includes(q.replace(/\s/g, "")),
        );
    return matches.slice(0, 20);
  }, [customersQuery.data, customerQuery]);

  const unitPrice = product?.price ?? usd(0);
  const subtotal = multiplyMoney(unitPrice, Math.max(1, quantity));
  const discount =
    discountEnabled && discountCents > 0 ? usd(Math.min(discountCents, subtotal.amount)) : usd(0);
  const total = subtractMoney(subtotal, discount);

  function reset() {
    setProductQuery("");
    setProduct(null);
    setQuantity(1);
    setSource("POS");
    setDiscountEnabled(false);
    setDiscountCents(0);
    setCustomerQuery("");
    setCustomer(null);
    setSubmitting(false);
    setFailure(null);
    setCreatedCode(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function submit() {
    if (!product?.variantId) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const detail = await createRealOrder({
        source,
        items: [{ variantId: product.variantId, quantity, productId: product.id }],
        customerId: customer?.id ?? null,
        ...(discountEnabled && discount.amount > 0 ? { discountMinor: discount.amount } : {}),
      });
      setCreatedCode(detail.order.code);
      window.setTimeout(() => {
        onCreated(detail.order);
        handleOpenChange(false);
      }, 1100);
    } catch (error) {
      setFailure(classifyOrderError(error) === "forbidden" ? "permission" : "generic");
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={createdCode ? undefined : t("orderCreate.title")}
      snap="full"
      className="lg:max-w-[520px]"
    >
      {createdCode ? (
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
            {t("orderCreate.created", { code: createdCode })}
          </p>
          <p className="text-body mt-1 text-text-secondary">{t("orderCreate.createdBody")}</p>
        </motion.div>
      ) : product ? (
        <section className="space-y-5 pb-4">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-caption text-text-muted">{t("orderCreate.product")}</p>
              <p className="text-h3 truncate text-text-primary">{localName(product, language)}</p>
              <p className="text-data text-text-muted">{product.sku}</p>
            </div>
            <button
              type="button"
              onClick={() => setProduct(null)}
              className="tap-target text-label shrink-0 px-2 text-action-primary"
            >
              {t("orderCreate.change")}
            </button>
          </div>

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
                {customersQuery.isSuccess && customerList.length === 0 ? (
                  <p className="text-caption text-text-muted">
                    {customerQuery ? t("orderCreate.noCustomers") : t("orderCreate.customerNone")}
                  </p>
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

          <Button
            className="tap-target h-12 w-full"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? t("orderCreate.creating") : t("orderCreate.submit")}
          </Button>
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
                  onClick={() => setProduct(item)}
                  disabled={!item.variantId}
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
