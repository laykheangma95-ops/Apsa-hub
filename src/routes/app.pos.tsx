import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, List, ScanLine, Search, ShoppingCart } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppHeader, BottomSheet, ErrorState, ListSkeleton } from "@/design-system";
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
import { cn } from "@/lib/utils";
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
        content: "A Khmer-first point of sale for Cambodian merchants — cart, discounts and payments.",
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
  const productsQuery = useQuery({ queryKey: ["pos-products"], queryFn: getPosProducts });

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

  function addProduct(product: Product, variant: string | undefined, quantity: number) {
    setLines((current) =>
      addToCart(current, {
        key: lineKey(product.id, variant),
        productId: product.id,
        nameKm: product.nameKm,
        nameEn: product.nameEn,
        sku: product.sku,
        ...(variant ? { variant } : {}),
        quantity,
        unitPrice: product.price,
        stock: Math.max(1, availableStock(product)),
      }),
    );
    setVariantProduct(null);
  }

  function selectProduct(product: Product) {
    if (product.options?.length) {
      setVariantProduct(product);
      return;
    }
    addProduct(product, undefined, 1);
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

  return (
    <div className="min-h-screen bg-surface-secondary pb-28 lg:pb-0">
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
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <div className="relative min-w-0">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-secondary"
                  aria-hidden
                />
                <Input
                  aria-label={t("pos.searchLabel")}
                  placeholder={t("pos.searchPlaceholder")}
                  className="h-12 pl-9"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <button
                type="button"
                aria-label={t("pos.scan")}
                onClick={() => setQuery("8850001000031")}
                className="tap-target flex shrink-0 items-center justify-center rounded-xl border border-border-strong bg-surface-primary px-3 text-text-primary"
              >
                <ScanLine className="size-5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={t(view === "list" ? "pos.view.grid" : "pos.view.list")}
                aria-pressed={view === "grid"}
                onClick={() => setView(view === "list" ? "grid" : "list")}
                className="tap-target col-start-2 flex shrink-0 items-center justify-center rounded-xl border border-border-strong bg-surface-primary px-3 text-text-primary"
              >
                {view === "list" ? (
                  <LayoutGrid className="size-5" aria-hidden />
                ) : (
                  <List className="size-5" aria-hidden />
                )}
              </button>
            </div>

            <div
              role="group"
              aria-label={t("pos.categories")}
              className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
            >
              {CATEGORIES.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={category === value}
                  onClick={() => setCategory(value)}
                  className={cn(
                    "tap-target shrink-0 rounded-full border px-4 text-label transition-colors",
                    category === value
                      ? "border-action-primary bg-action-primary text-text-on-action"
                      : "border-border-strong bg-surface-primary text-text-primary",
                  )}
                >
                  <span className="chip-text">{t(`pos.category.${value}`)}</span>
                </button>
              ))}
            </div>
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

      {/* Mobile: total + checkout stay pinned above the fold. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border-default bg-surface-primary px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] lg:hidden">
        <div className="mx-auto grid max-w-[560px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="tap-target flex min-w-0 items-center gap-2 text-left"
          >
            <ShoppingCart className="size-5 shrink-0 text-text-secondary" aria-hidden />
            <span className="min-w-0">
              <span className="text-caption block text-text-secondary">
                {t("pos.itemCount", { count: totals.itemCount })}
              </span>
              <span className="text-financial block truncate text-text-primary">
                {formatMoney(totals.total)}
              </span>
            </span>
          </button>
          <Button
            className="tap-target shrink-0"
            disabled={totals.itemCount === 0 || approvalRequired || offline}
            onClick={() => setCheckoutOpen(true)}
          >
            {t("pos.checkout")}
          </Button>
        </div>
      </div>

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
    </div>
  );
}
