import { createFileRoute } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, List, ScanLine, Search, ShoppingCart } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AppHeader,
  BottomNav,
  BottomSheet,
  Chip,
  ChipRow,
  ErrorState,
  ListSkeleton,
} from "@/design-system";
import { CapabilityDeniedState } from "@/components/common/CapabilityDeniedState";
import { useCapabilities } from "@/hooks/use-capabilities";
import { PosNotice } from "@/components/pos/PosNotice";
import { PosCart } from "@/components/pos/PosCart";
import { PosCheckoutSheet } from "@/components/pos/PosCheckoutSheet";
import { PosCustomerSheet } from "@/components/pos/PosCustomerSheet";
import { PosProductList } from "@/components/pos/PosProductList";
import { PosVariantSheet } from "@/components/pos/PosVariantSheet";
import { getActiveShop, getPosProducts } from "@/lib/api";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { formatMoney } from "@/lib/money";
import {
  addToCart,
  availableStock,
  calculateCartTotals,
  lineKey,
  needsManagerApproval,
  removeLine,
  setQuantity,
  type CartDiscountInput,
  type CartLine,
} from "@/lib/pos-cart";
import type { Customer, Product, ProductCategory } from "@/types";

export const Route = createFileRoute("/app/pos")({
  head: () => ({
    meta: [
      { title: "Point of Sale — APSA" },
      {
        name: "description",
        content:
          "Ring up counter sales fast: search products, build a cart, take cash, KHQR, bank transfer or COD.",
      },
      { property: "og:title", content: "Point of Sale — APSA" },
      {
        property: "og:description",
        content:
          "A Khmer-first point of sale for Cambodian merchants — cart, discounts and payments.",
      },
    ],
  }),
  component: PosScreen,
});

const CATEGORIES: (ProductCategory | "all")[] = [
  "all",
  "skincare",
  "apparel",
  "accessories",
  "drinks",
];

function PosScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const reduceMotion = useReducedMotion();
  const capabilities = useCapabilities();
  /*
   * POS exists to take a sale, and taking a sale is createOrder — which
   * requires orders.create server-side (src/server/orders/service.ts). Without
   * it there is no honest version of this screen: a merchant would build a
   * cart the server will refuse at checkout. So the whole entry point closes.
   */
  const canSell = capabilities.can("orders.create");

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ProductCategory | "all">("all");
  const [view, setView] = useState<"list" | "grid">("list");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState<CartDiscountInput>({
    enabled: false,
    mode: "amount",
    value: 0,
  });
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [variantProduct, setVariantProduct] = useState<Product | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const shopQuery = useQuery({ queryKey: ["shop"], queryFn: getActiveShop });
  const productsQuery = useQuery({
    queryKey: ["pos-products"],
    queryFn: getPosProducts,
    enabled: canSell,
  });

  const catalog = productsQuery.data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((p) => {
      if (category !== "all" && p.category !== category) return false;
      if (!q) return true;
      return (
        p.nameEn.toLowerCase().includes(q) ||
        p.nameKm.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode ?? "").includes(q)
      );
    });
  }, [catalog, category, query]);

  const totals = calculateCartTotals(lines, discount);
  const approvalRequired = needsManagerApproval(discount, totals);

  function addProduct(
    product: Product,
    variant: string | undefined,
    quantity: number,
    variantId?: string,
  ) {
    // Production line price: the chosen variant's own price when one was
    // explicitly picked, otherwise the product's default (single-variant
    // production products, or the mock path). Never guessed independently of
    // which variant is actually being added — see PosVariantSheet.
    const chosenVariant = product.productionVariants?.find((v) => v.variantId === variantId);
    const unitPrice = chosenVariant?.price ?? product.price;
    setLines((current) =>
      addToCart(current, {
        key: lineKey(product.id, variantId ?? variant),
        productId: product.id,
        ...(variantId ? { variantId } : {}),
        nameKm: product.nameKm,
        nameEn: product.nameEn,
        sku: chosenVariant?.sku || product.sku,
        ...(variant ? { variant } : {}),
        quantity,
        unitPrice,
        stock: Math.max(1, availableStock(product)),
      }),
    );
    setVariantProduct(null);
  }

  function selectProduct(product: Product) {
    // A product needs an explicit choice when the mock prototype's option
    // matrix is present, or when the production catalog returned more than
    // one ACTIVE variant (see ProductionVariant's own comment) — never guess
    // between them.
    if (product.options?.length || (product.productionVariants?.length ?? 0) > 1) {
      setVariantProduct(product);
      return;
    }
    addProduct(product, undefined, 1, product.variantId);
  }

  function resetSale() {
    setLines([]);
    setDiscount({ enabled: false, mode: "amount", value: 0 });
    setCustomer(null);
    setCartOpen(false);
  }

  const cartProps = {
    lines,
    totals,
    discount,
    onDiscountChange: setDiscount,
    approvalRequired,
    customer,
    onPickCustomer: () => setCustomerOpen(true),
    onClearCustomer: () => setCustomer(null),
    onQuantity: (key: string, quantity: number) =>
      setLines((current) => setQuantity(current, key, quantity)),
    onRemove: (key: string) => setLines((current) => removeLine(current, key)),
    onClear: resetSale,
    onCheckout: () => {
      setCartOpen(false);
      setCheckoutOpen(true);
    },
    offline,
  };

  if (!canSell) {
    return (
      <div className="min-h-dvh bg-surface-secondary pb-[var(--nav-clearance)]">
        <AppHeader title={t("pos.title")} onBack={() => window.history.back()} />
        <main className="mx-auto w-full max-w-[var(--screen-max)] px-4 pt-3">
          <CapabilityDeniedState capabilities={capabilities} />
        </main>
        <BottomNav workspace="business" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-surface-secondary pb-[calc(var(--nav-clearance)+var(--action-bar-height))] lg:pb-0">
      <AppHeader
        title={t("pos.title")}
        subtitle={shopQuery.data ? localName(shopQuery.data, language) : undefined}
        onBack={() => window.history.back()}
      />

      {offline ? (
        <p
          role="alert"
          className="text-body-sm bg-status-danger-soft px-4 py-2 text-status-danger-text"
        >
          {t("pos.offline")}
        </p>
      ) : null}

      <div className="mx-auto flex max-w-[1200px] flex-col lg:flex-row lg:items-start lg:gap-4 lg:px-4 lg:py-4">
        <main className="min-w-0 flex-1">
          <div className="space-y-3 bg-surface-primary px-4 py-3 lg:rounded-2xl lg:border lg:border-border-default">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-secondary"
                  aria-hidden
                />
                <Input
                  aria-label={t("pos.searchLabel")}
                  placeholder={t("pos.searchPlaceholder")}
                  className="h-12 rounded-2xl border-border-default pl-9"
                  type="search"
                  enterKeyHint="search"
                  autoComplete="off"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <button
                type="button"
                aria-label={t("pos.scan")}
                onClick={() => setQuery("8850001000031")}
                className="press-tactile tap-target flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border-default bg-surface-primary text-text-primary"
              >
                <ScanLine className="size-5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={t(view === "list" ? "pos.view.grid" : "pos.view.list")}
                aria-pressed={view === "grid"}
                onClick={() => setView(view === "list" ? "grid" : "list")}
                className="press-tactile tap-target flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border-default bg-surface-primary text-text-primary"
              >
                {view === "list" ? (
                  <LayoutGrid className="size-5" aria-hidden />
                ) : (
                  <List className="size-5" aria-hidden />
                )}
              </button>
            </div>

            <ChipRow label={t("pos.categories")} className="-mx-4 px-4">
              {CATEGORIES.map((value) => (
                <Chip key={value} selected={category === value} onClick={() => setCategory(value)}>
                  {t(`pos.category.${value}`)}
                </Chip>
              ))}
            </ChipRow>
          </div>

          <section
            aria-label={t("pos.products")}
            className="mt-3 bg-surface-primary lg:rounded-2xl lg:border lg:border-border-default"
          >
            {productsQuery.isPending ? <ListSkeleton rows={5} /> : null}

            {productsQuery.isError ? (
              <ErrorState onRetry={() => void productsQuery.refetch()} />
            ) : null}

            {!productsQuery.isPending && !productsQuery.isError && catalog.length === 0 ? (
              <PosNotice title={t("pos.empty.title")} body={t("pos.empty.body")} />
            ) : null}

            {catalog.length > 0 && filtered.length === 0 ? (
              <PosNotice title={t("pos.noResults.title")} body={t("pos.noResults.body")} />
            ) : null}

            {filtered.length > 0 ? (
              <PosProductList products={filtered} view={view} onSelect={selectProduct} />
            ) : null}
          </section>
        </main>

        {/* Tablet/desktop: cart lives beside the catalogue, never a separate product. */}
        <aside className="hidden w-[360px] shrink-0 lg:block">
          <div className="sticky top-4 flex max-h-[calc(100vh-2rem)] flex-col rounded-2xl border border-border-default bg-surface-primary p-4">
            <h2 className="text-h3 pb-2 text-text-primary">{t("pos.cart.title")}</h2>
            <PosCart {...cartProps} />
          </div>
        </aside>
      </div>

      {/*
       * The cart bar is the sale in progress, so it only exists once there is
       * one. An empty bar reading "0 items" cost 70px of catalogue on every
       * phone for no information; it now slides in with the first tap and the
       * merchant gets the extra row of products back while browsing.
       */}
      <AnimatePresence>
        {totals.itemCount > 0 ? (
          <motion.div
            initial={reduceMotion ? false : { y: "100%", opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { y: "100%", opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.2, 0, 0, 1] }}
            className="glass-bar fixed inset-x-0 bottom-[var(--nav-clearance)] z-40 border-t border-[var(--glass-border)] px-4 pt-2.5 pb-2.5 lg:hidden"
          >
            <div className="mx-auto flex max-w-[var(--screen-max)] items-center gap-3">
              <button
                type="button"
                onClick={() => setCartOpen(true)}
                aria-haspopup="dialog"
                className="press tap-target flex min-w-0 flex-1 items-center gap-2 rounded-2xl text-left"
              >
                <span className="relative shrink-0">
                  <ShoppingCart className="size-5 text-text-secondary" aria-hidden />
                  <span className="text-caption tnum absolute -top-1.5 -right-2 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-action-primary px-1 leading-none text-text-on-action">
                    {totals.itemCount > 99 ? "99+" : totals.itemCount}
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="text-caption block text-text-secondary">
                    {t("pos.itemCount", { count: totals.itemCount })}
                  </span>
                  <span className="text-h2 tnum block truncate text-text-primary">
                    {formatMoney(totals.total)}
                  </span>
                </span>
              </button>
              <Button
                className="press-tactile tap-target elevation-action h-12 shrink-0 rounded-2xl px-5"
                disabled={approvalRequired || offline}
                onClick={() => setCheckoutOpen(true)}
              >
                {t("pos.checkout")}
              </Button>
            </div>
            {approvalRequired || offline ? (
              <p
                role="status"
                className="text-caption mx-auto mt-1.5 max-w-[var(--screen-max)] text-status-warning-text"
              >
                {offline ? t("pos.offline") : t("pos.discount.approval")}
              </p>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <BottomSheet
        open={cartOpen}
        onOpenChange={setCartOpen}
        title={t("pos.cart.title")}
        snap="full"
      >
        <PosCart {...cartProps} />
      </BottomSheet>

      <PosVariantSheet
        product={variantProduct}
        onOpenChange={(open) => {
          if (!open) setVariantProduct(null);
        }}
        onAdd={addProduct}
      />

      <PosCustomerSheet
        open={customerOpen}
        onOpenChange={setCustomerOpen}
        onSelect={(next) => {
          setCustomer(next);
          setCustomerOpen(false);
        }}
      />

      <PosCheckoutSheet
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        lines={lines}
        totals={totals}
        customer={customer}
        offline={offline}
        onCompleted={resetSale}
      />

      <BottomNav workspace="business" />
    </div>
  );
}
