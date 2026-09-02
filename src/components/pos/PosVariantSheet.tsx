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
  onAdd: (product: Product, variant: string | undefined, quantity: number) => void;
}

export function PosVariantSheet({ product, onOpenChange, onAdd }: PosVariantSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (product) {
      setSelection(defaultVariantSelection(product.options));
      setQuantity(1);
    }
  }, [product]);

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
            <span className="text-financial text-text-primary">{formatMoney(product.price)}</span>
          </div>

          {product.options?.map((option) => (
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
          ))}

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
            onClick={() => onAdd(product, variantLabel(selection), quantity)}
          >
            {t("pos.addToCart")}
          </Button>
        </div>
      ) : null}
    </BottomSheet>
  );
}
