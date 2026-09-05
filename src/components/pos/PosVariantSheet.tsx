import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { BottomSheet, QuantityStepper } from "@/design-system";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { formatMoney } from "@/lib/money";
import { defaultVariantSelection, variantLabel } from "@/lib/order-draft";
import { availableStock } from "@/lib/pos-cart";
import { cn } from "@/lib/utils";
import type { Product } from "@/types";

interface PosVariantSheetProps {
  product: Product | null;
  onOpenChange: (open: boolean) => void;
  /**
   * variantId is present only on the production path (the mock `options`
   * path has no DB-backed variant to reference — see CartLine's own comment).
   */
  onAdd: (
    product: Product,
    variant: string | undefined,
    quantity: number,
    variantId?: string,
  ) => void;
}

export function PosVariantSheet({ product, onOpenChange, onAdd }: PosVariantSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);

  // Production products with more than one ACTIVE variant: no attribute matrix
  // (size/color) exists server-side, just a flat named/priced list — see
  // ProductionVariant's own comment. The mock `options` chip UI below is used
  // only when this list is absent.
  const productionVariants = product?.productionVariants ?? [];
  const hasProductionVariants = productionVariants.length > 1;

  useEffect(() => {
    if (product) {
      setSelection(defaultVariantSelection(product.options));
      setQuantity(1);
      // Never pre-select a production variant — the merchant must choose
      // explicitly (PHASE spec: "Do not guess between multiple variants").
      setSelectedVariantId(null);
    }
  }, [product]);

  const selectedVariant = productionVariants.find((v) => v.variantId === selectedVariantId) ?? null;
  const displayPrice = selectedVariant?.price ?? product?.price;

  return (
    <BottomSheet
      open={product !== null}
      onOpenChange={onOpenChange}
      title={product ? localName(product, language) : undefined}
      snap="half"
    >
      {product ? (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <span className="text-label text-text-secondary">{t("pos.unitPrice")}</span>
            <span className="text-financial text-text-primary">
              {displayPrice ? formatMoney(displayPrice) : formatMoney(product.price)}
            </span>
          </div>

          {hasProductionVariants ? (
            <div>
              <p className="text-label text-text-secondary">{t("pos.variant.chooseOne")}</p>
              <ul className="mt-2 space-y-2">
                {productionVariants.map((v) => {
                  const selected = v.variantId === selectedVariantId;
                  return (
                    <li key={v.variantId}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setSelectedVariantId(v.variantId)}
                        className={cn(
                          "tap-target flex w-full items-center justify-between rounded-xl border px-4 py-2.5 text-left transition-colors",
                          selected
                            ? "border-action-primary bg-action-primary-soft text-action-primary"
                            : "border-border-strong bg-surface-primary text-text-primary",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-label">{v.name}</span>
                        <span className="text-financial shrink-0">{formatMoney(v.price)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            product.options?.map((option) => (
              <div key={option.name}>
                <p className="text-label text-text-secondary capitalize">{option.name}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {option.values.map((value) => {
                    const selected = selection[option.name] === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setSelection((s) => ({ ...s, [option.name]: value }))}
                        className={cn(
                          "tap-target rounded-full border px-4 text-label transition-colors",
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
            ))
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="text-label text-text-secondary">{t("common.quantity")}</span>
            <QuantityStepper
              value={quantity}
              onChange={setQuantity}
              max={Math.max(1, availableStock(product))}
            />
          </div>

          <Button
            className="tap-target w-full"
            disabled={hasProductionVariants && !selectedVariant}
            onClick={() =>
              hasProductionVariants && selectedVariant
                ? onAdd(product, selectedVariant.name, quantity, selectedVariant.variantId)
                : onAdd(product, variantLabel(selection), quantity, product.variantId)
            }
          >
            {t("pos.addToCart")}
          </Button>
        </div>
      ) : null}
    </BottomSheet>
  );
}
