import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { QuantityStepper } from "@/design-system";
import { LabelSheet } from "./LabelSheet";
import { ProductLabel } from "./ProductLabel";
import { buildProductLabel, PRODUCT_LABEL_SIZE_MM } from "@/lib/labels/product-label";
import type { Money } from "@/types";

/**
 * Product label preview + print (§6, §7). The merchant chooses how many copies
 * to print — "received 30 units → print 30 labels" — and whether to include the
 * optional APSA QR. Browser/system print only.
 */
export interface ProductLabelDialogProps {
  open: boolean;
  onClose: () => void;
  productName: string;
  variantName?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price: Money;
  /** Enables the optional QR toggle; must be a real variant UUID. */
  variantId?: string | null;
}

export function ProductLabelDialog({
  open,
  onClose,
  productName,
  variantName,
  sku,
  barcode,
  price,
  variantId,
}: ProductLabelDialogProps) {
  const { t } = useTranslation();
  const [quantity, setQuantity] = useState(1);
  const [includeQr, setIncludeQr] = useState(false);

  const qrAvailable = Boolean(variantId);

  const vm = useMemo(
    () =>
      buildProductLabel({
        productName,
        variantName: variantName ?? null,
        sku: sku ?? null,
        barcode: barcode ?? null,
        price,
        includeQr: includeQr && qrAvailable,
        variantId: variantId ?? null,
      }),
    [productName, variantName, sku, barcode, price, includeQr, qrAvailable, variantId],
  );

  if (!open) return null;

  const controls = (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <span className="text-label text-text-secondary">{t("labels.product.quantity")}</span>
        <QuantityStepper value={quantity} onChange={setQuantity} min={1} max={200} />
      </div>
      {qrAvailable ? (
        <div className="flex items-center gap-2">
          <Switch id="product-label-qr" checked={includeQr} onCheckedChange={setIncludeQr} />
          <Label htmlFor="product-label-qr" className="text-label text-text-secondary">
            {t("labels.product.includeQr")}
          </Label>
        </div>
      ) : null}
    </div>
  );

  return (
    <LabelSheet
      open={open}
      onClose={onClose}
      title={t("labels.product.title")}
      pageSize={PRODUCT_LABEL_SIZE_MM}
      controls={controls}
    >
      {Array.from({ length: quantity }, (_, i) => (
        <ProductLabel key={i} vm={vm} />
      ))}
    </LabelSheet>
  );
}
