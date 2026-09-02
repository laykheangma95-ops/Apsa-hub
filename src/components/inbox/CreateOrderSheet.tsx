import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BottomSheet, ErrorState, QuantityStepper, SkeletonBlock } from "@/design-system";
import { createOrder, getRecentProducts, PERMISSION_DENIED } from "@/lib/api";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { formatMoney, usd, usdToKhr } from "@/lib/money";
import {
  calculateDraftTotals,
  defaultVariantSelection,
  variantLabel,
  type DiscountMode,
} from "@/lib/order-draft";
import { cn } from "@/lib/utils";
import type { Channel, Customer, Order, Product } from "@/types";

interface CreateOrderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: Customer;
  displayName: string;
  channel: Channel;
  onCreated: (order: Order) => void;
}

const chipClass =
  "tap-target rounded-full border px-4 text-label transition-colors";

export function CreateOrderSheet({
  open,
  onOpenChange,
  customer,
  displayName,
  channel,
  onCreated,
}: CreateOrderSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();

  const [query, setQuery] = useState("");
  const [product, setProduct] = useState<Product | null>(null);
  const [variant, setVariant] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const [discountEnabled, setDiscountEnabled] = useState(false);
  const [discountMode, setDiscountMode] = useState<DiscountMode>("amount");
  const [discountValue, setDiscountValue] = useState(0);
  const [deliveryFeeCents, setDeliveryFeeCents] = useState(90);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<"generic" | "permission" | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  const productsQuery = useQuery({
    queryKey: ["recent-products"],
    queryFn: getRecentProducts,
    enabled: open,
  });

  const list = useMemo(() => {
    const all = productsQuery.data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.nameEn.toLowerCase().includes(q) ||
        p.nameKm.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q),
    );
  }, [productsQuery.data, query]);

  const totals = calculateDraftTotals({
    unitPrice: product?.price ?? usd(0),
    quantity,
    discountEnabled,
    discountMode,
    discountValue,
    deliveryFeeCents,
  });

  function reset() {
    setQuery("");
    setProduct(null);
    setVariant({});
    setQuantity(1);
    setDiscountEnabled(false);
    setDiscountMode("amount");
    setDiscountValue(0);
    setDeliveryFeeCents(90);
    setSubmitting(false);
    setFailure(null);
    setCreatedCode(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  /** One tap: selects the product AND pre-selects its default variant. */
  function pickProduct(next: Product) {
    setProduct(next);
    setVariant(defaultVariantSelection(next.options));
  }

  async function submit() {
    if (!product) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const order = await createOrder({
        customerId: customer.id,
        channel,
        items: [
          {
            productId: product.id,
            nameKm: product.nameKm,
            nameEn: product.nameEn,
            ...(variantLabel(variant) ? { variant: variantLabel(variant)! } : {}),
            quantity,
            unitPrice: product.price,
          },
        ],
        subtotal: totals.subtotal,
        discount: totals.discount,
        deliveryFee: totals.deliveryFee,
        total: totals.total,
      });
      setCreatedCode(order.code);
      window.setTimeout(() => {
        onCreated(order);
        handleOpenChange(false);
      }, 1100);
    } catch (error) {
      setFailure(error instanceof Error && error.message === PERMISSION_DENIED ? "permission" : "generic");
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={createdCode ? undefined : t("createOrder.title")}
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
            {t("createOrder.created", { code: createdCode })}
          </p>
          <p className="text-body mt-1 text-text-secondary">{t("createOrder.createdBody")}</p>
        </motion.div>
      ) : (
        <div className="space-y-5 pb-4">
          {/* Customer is pre-filled and locked. */}
          <section className="rounded-xl border border-border-default bg-surface-secondary px-3 py-2.5">
            <p className="text-caption text-text-muted">{t("createOrder.customer")}</p>
            <p className="text-label text-text-primary">{displayName}</p>
            <p className="text-caption tnum text-text-muted">
              {customer.phone} · {t("createOrder.locked")}
            </p>
          </section>

          {product ? (
            <section className="space-y-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-caption text-text-muted">{t("createOrder.product")}</p>
                  <p className="text-h3 truncate text-text-primary">
                    {localName(product, language)}
                  </p>
                  <p className="text-data text-text-muted">{product.sku}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setProduct(null)}
                  className="tap-target text-label shrink-0 px-2 text-action-primary"
                >
                  {t("createOrder.change")}
                </button>
              </div>

              {product.options?.map((option) => (
                <div key={option.name}>
                  <p className="text-label text-text-secondary capitalize">{option.name}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {option.values.map((value) => {
                      const selected = variant[option.name] === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setVariant((v) => ({ ...v, [option.name]: value }))}
                          className={cn(
                            chipClass,
                            selected
                              ? "border-action-primary bg-action-primary text-text-on-action"
                              : "border-border-strong bg-surface-primary text-text-primary",
                          )}
                        >
                          <span className="chip-text">{value}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between gap-3">
                <span className="text-label text-text-secondary">{t("createOrder.quantity")}</span>
                <QuantityStepper value={quantity} onChange={setQuantity} max={product.stock} />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-label text-text-secondary">{t("createOrder.unitPrice")}</span>
                <span className="text-financial text-text-primary">
                  {formatMoney(product.price)}
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-label text-text-secondary">
                    {t("createOrder.discount")}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={discountEnabled}
                    aria-label={t("createOrder.discount")}
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
                  <div className="flex items-center gap-2">
                    <div className="flex rounded-full border border-border-default p-0.5">
                      {(["amount", "percent"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          aria-pressed={discountMode === mode}
                          onClick={() => {
                            setDiscountMode(mode);
                            setDiscountValue(0);
                          }}
                          className={cn(
                            "text-caption chip-text rounded-full px-3 py-2",
                            discountMode === mode
                              ? "bg-action-primary text-text-on-action"
                              : "text-text-secondary",
                          )}
                        >
                          {t(
                            mode === "amount"
                              ? "createOrder.discountAmount"
                              : "createOrder.discountPercent",
                          )}
                        </button>
                      ))}
                    </div>
                    <Input
                      inputMode="decimal"
                      aria-label={t("createOrder.discount")}
                      className="text-financial h-12 flex-1"
                      value={
                        discountMode === "amount"
                          ? (discountValue / 100).toFixed(2)
                          : String(discountValue)
                      }
                      onChange={(e) => {
                        const parsed = Number.parseFloat(e.target.value.replace(/[^0-9.]/g, ""));
                        const safe = Number.isFinite(parsed) ? parsed : 0;
                        setDiscountValue(
                          discountMode === "amount" ? Math.round(safe * 100) : Math.round(safe),
                        );
                      }}
                    />
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-label text-text-secondary">{t("createOrder.delivery")}</span>
                <Input
                  inputMode="decimal"
                  aria-label={t("createOrder.delivery")}
                  className="text-financial h-12 w-28 text-right"
                  value={(deliveryFeeCents / 100).toFixed(2)}
                  onChange={(e) => {
                    const parsed = Number.parseFloat(e.target.value.replace(/[^0-9.]/g, ""));
                    setDeliveryFeeCents(Number.isFinite(parsed) ? Math.round(parsed * 100) : 0);
                  }}
                />
              </div>

              <div className="rounded-xl border border-border-default bg-surface-secondary p-3">
                <div className="flex items-center justify-between">
                  <span className="text-body-sm text-text-secondary">
                    {t("createOrder.subtotal")}
                  </span>
                  <span className="text-data text-text-primary">
                    {formatMoney(totals.subtotal)}
                  </span>
                </div>
                {totals.discount.amount > 0 ? (
                  <div className="flex items-center justify-between">
                    <span className="text-body-sm text-text-secondary">
                      {t("createOrder.discount")}
                    </span>
                    <span className="text-data text-text-primary">
                      -{formatMoney(totals.discount)}
                    </span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between">
                  <span className="text-body-sm text-text-secondary">
                    {t("createOrder.delivery")}
                  </span>
                  <span className="text-data text-text-primary">
                    {formatMoney(totals.deliveryFee)}
                  </span>
                </div>
                <div className="mt-2 flex items-end justify-between border-t border-border-default pt-2">
                  <span className="text-label text-text-primary">{t("createOrder.total")}</span>
                  <span className="text-right">
                    <span className="text-financial-lg block text-text-primary">
                      {formatMoney(totals.total)}
                    </span>
                    <span className="text-data block text-text-muted">
                      {t("money.approx", { value: formatMoney(usdToKhr(totals.total)) })}
                    </span>
                  </span>
                </div>
              </div>

              {failure ? (
                <ErrorState
                  title={t(
                    failure === "permission"
                      ? "createOrder.permission.title"
                      : "createOrder.error.title",
                  )}
                  body={t(
                    failure === "permission"
                      ? "createOrder.permission.body"
                      : "createOrder.error.body",
                  )}
                  onRetry={() => void submit()}
                  className="py-4"
                />
              ) : null}

              <Button
                className="tap-target h-12 w-full"
                disabled={submitting}
                onClick={() => void submit()}
              >
                {submitting ? t("createOrder.creating") : t("createOrder.submit")}
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
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("createOrder.searchProducts")}
                  aria-label={t("createOrder.searchProducts")}
                  className="h-12 pl-9"
                />
              </div>

              <p className="text-caption mt-3 text-text-muted">
                {query ? t("createOrder.allProducts") : t("createOrder.recents")}
              </p>

              {productsQuery.isPending ? (
                <div className="mt-2 space-y-2">
                  <SkeletonBlock className="h-14 w-full" />
                  <SkeletonBlock className="h-14 w-full" />
                  <SkeletonBlock className="h-14 w-full" />
                </div>
              ) : null}

              {productsQuery.isError ? (
                <ErrorState onRetry={() => void productsQuery.refetch()} className="py-6" />
              ) : null}

              {productsQuery.isSuccess && list.length === 0 ? (
                <p className="text-body-sm mt-3 text-text-secondary">
                  {t("createOrder.noProducts")}
                </p>
              ) : null}

              <ul className="mt-2 space-y-2">
                {list.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => pickProduct(item)}
                      disabled={item.stock === 0}
                      className="tap-target flex w-full items-center gap-3 rounded-xl border border-border-default bg-surface-primary px-3 py-2.5 text-left transition-colors hover:bg-surface-secondary disabled:opacity-50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="text-label block truncate text-text-primary">
                          {localName(item, language)}
                        </span>
                        <span className="text-caption tnum block truncate text-text-muted">
                          {item.sku}
                          {item.options?.length
                            ? ` · ${item.options.map((o) => o.values.join("/")).join(" · ")}`
                            : ""}
                        </span>
                        <span
                          className={cn(
                            "text-caption block",
                            item.stock === 0 ? "text-status-danger" : "text-text-secondary",
                          )}
                        >
                          {item.stock === 0
                            ? t("createOrder.outOfStock")
                            : t("createOrder.stock", { count: item.stock })}
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
        </div>
      )}
    </BottomSheet>
  );
}
