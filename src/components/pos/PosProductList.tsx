import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StatusChip } from "@/design-system";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { formatMoney } from "@/lib/money";
import { availableStock, stockState } from "@/lib/pos-cart";
import { cn } from "@/lib/utils";
import type { Product } from "@/types";

interface PosProductListProps {
  products: Product[];
  view: "list" | "grid";
  onSelect: (product: Product) => void;
}

const COMPANION_VAR: Record<Product["companion"], string> = {
  nilo: "var(--companion-nilo)",
  minto: "var(--companion-minto)",
  vela: "var(--companion-vela)",
  suri: "var(--companion-suri)",
  luma: "var(--companion-luma)",
};

/** Thumb placeholder: products carry no imagery in mock data. */
function Thumb({ product, size }: { product: Product; size: "sm" | "lg" }) {
  const { language } = useLanguage();
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl text-text-inverse",
        size === "sm" ? "size-11 text-body" : "h-20 w-full text-h3",
      )}
      style={{ backgroundColor: COMPANION_VAR[product.companion] }}
    >
      {localName(product, language).slice(0, 1)}
    </span>
  );
}

export function PosProductList({ products, view, onSelect }: PosProductListProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();

  return (
    <ul
      className={cn(
        view === "grid"
          ? "grid grid-cols-2 gap-2 px-4 py-3 sm:grid-cols-3"
          : "divide-y divide-border-default",
      )}
    >
      {products.map((product) => {
        const state = stockState(product);
        const disabled = state === "out_of_stock";
        const name = localName(product, language);
        const variants = product.options?.map((o) => o.values.join("/")).join(" · ");
        const label = t("pos.addToCartLabel", { name });

        if (view === "grid") {
          return (
            <li key={product.id}>
              <button
                type="button"
                onClick={() => onSelect(product)}
                disabled={disabled}
                aria-label={label}
                className="press tap-target flex h-full w-full flex-col gap-2 rounded-2xl border border-border-default bg-surface-primary p-2 text-left transition-colors hover:bg-surface-secondary disabled:opacity-50"
              >
                <Thumb product={product} size="lg" />
                <span className="text-body-sm line-clamp-2 text-text-primary">{name}</span>
                <span className="text-financial text-text-primary">
                  {formatMoney(product.price)}
                </span>
                <span className="text-caption text-text-muted">
                  {t("pos.available", { count: availableStock(product) })}
                </span>
                {state !== "available" ? <StatusChip status={state} size="sm" /> : null}
              </button>
            </li>
          );
        }

        return (
          <li key={product.id}>
            {/*
             * The whole row rings the product up. Behind a counter the target
             * is the product, not a 44px plus sign at the far edge of the
             * phone — the icon stays as the affordance, not as the only way in.
             */}
            <button
              type="button"
              onClick={() => onSelect(product)}
              disabled={disabled}
              aria-label={label}
              className="press flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-secondary disabled:opacity-50"
            >
              <Thumb product={product} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="text-body block truncate text-text-primary">{name}</span>
                <span className="text-caption block truncate text-text-secondary">
                  {product.sku}
                  {variants ? ` · ${variants}` : ""}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-financial text-text-primary">
                    {formatMoney(product.price)}
                  </span>
                  <span className="text-caption text-text-muted">
                    {t("pos.available", { count: availableStock(product) })}
                  </span>
                  {product.reserved ? (
                    <span className="text-caption text-text-muted">
                      {t("pos.reserved", { count: product.reserved })}
                    </span>
                  ) : null}
                  {state !== "available" ? <StatusChip status={state} size="sm" /> : null}
                </span>
              </span>
              <span
                aria-hidden
                className="tap-target flex shrink-0 items-center justify-center rounded-2xl bg-action-primary-soft px-3 text-action-primary"
              >
                <Plus className="size-5" />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
