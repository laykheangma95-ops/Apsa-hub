import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BottomSheet } from "@/design-system";
import { MoneyAmountField } from "@/components/products/MoneyAmountField";
import { CategoryChoice } from "@/components/products/CategoryChoice";
import {
  catalogErrorKey,
  classifyCatalogError,
  createCatalogProduct,
  parseMinorUnits,
  type CatalogCategory,
  type CatalogProduct,
} from "@/lib/catalog";
import type { Currency } from "@/types";

interface CreateProductSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: readonly CatalogCategory[];
  /** True only when the server says this member has products.update_cost. */
  canSetCost: boolean;
  onCreated: (product: CatalogProduct) => void;
}

/**
 * Create a product and its first variant in one pass.
 *
 * The Khmer name is required here because it is required by the domain — the
 * server rejects an empty name_km — and because Khmer is the name a Cambodian
 * merchant's customers actually read. English is optional and never stands in
 * for it.
 */
export function CreateProductSheet({
  open,
  onOpenChange,
  categories,
  canSetCost,
  onCreated,
}: CreateProductSheetProps) {
  const { t } = useTranslation();
  const [nameKm, setNameKm] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [descriptionKm, setDescriptionKm] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [priceText, setPriceText] = useState("");
  const [priceCurrency, setPriceCurrency] = useState<Currency>("USD");
  const [costText, setCostText] = useState("");
  const [costCurrency, setCostCurrency] = useState<Currency>("USD");
  const [touched, setTouched] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [costError, setCostError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const nameError = touched && nameKm.trim() === "" ? t("catalog.detail.nameKmMissing") : null;

  function reset() {
    setNameKm("");
    setNameEn("");
    setDescriptionKm("");
    setCategoryId(null);
    setSku("");
    setBarcode("");
    setPriceText("");
    setPriceCurrency("USD");
    setCostText("");
    setCostCurrency("USD");
    setTouched(false);
    setPriceError(null);
    setCostError(null);
    setFormError(null);
  }

  async function submit() {
    setTouched(true);
    setFormError(null);

    const priceAmount = parseMinorUnits(priceText, priceCurrency);
    const priceInvalid = priceAmount === null;
    setPriceError(priceInvalid ? t("catalog.variant.invalidPrice") : null);

    let costAmount: number | null = null;
    let costInvalid = false;
    if (canSetCost && costText.trim() !== "") {
      costAmount = parseMinorUnits(costText, costCurrency);
      costInvalid = costAmount === null;
    }
    setCostError(costInvalid ? t("catalog.variant.invalidCost") : null);

    if (nameKm.trim() === "" || priceInvalid || costInvalid || priceAmount === null) return;

    setSaving(true);
    try {
      const product = await createCatalogProduct({
        nameKm: nameKm.trim(),
        nameEn: nameEn.trim() === "" ? null : nameEn.trim(),
        descriptionKm: descriptionKm.trim() === "" ? null : descriptionKm.trim(),
        categoryId,
        initialVariant: {
          sku: sku.trim() === "" ? null : sku.trim(),
          barcode: barcode.trim() === "" ? null : barcode.trim(),
          name: "",
          priceAmount,
          priceCurrency,
          costAmount,
          costCurrency: costAmount === null ? null : costCurrency,
          weightGrams: null,
        },
      });
      onCreated(product);
      reset();
      onOpenChange(false);
    } catch (err) {
      setFormError(t(catalogErrorKey(classifyCatalogError(err))));
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={t("catalog.list.addProduct")}
      snap="full"
      className="lg:max-w-[520px]"
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-name-km" className="text-label text-text-secondary">
            {t("catalog.detail.nameKm")}
          </Label>
          <Input
            id="product-name-km"
            className="h-12"
            value={nameKm}
            lang="km"
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => setNameKm(event.target.value)}
          />
          {nameError ? (
            <p className="text-caption text-status-danger-text" role="alert">
              {nameError}
            </p>
          ) : (
            <span className="text-caption text-text-secondary">
              {t("catalog.detail.nameKmHint")}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-name-en" className="text-label text-text-secondary">
            {t("catalog.detail.nameEn")}
          </Label>
          <Input
            id="product-name-en"
            className="h-12"
            value={nameEn}
            lang="en"
            onChange={(event) => setNameEn(event.target.value)}
          />
          <span className="text-caption text-text-secondary">{t("catalog.detail.nameEnHint")}</span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-description-km" className="text-label text-text-secondary">
            {t("catalog.detail.descriptionKm")}
          </Label>
          <Textarea
            id="product-description-km"
            value={descriptionKm}
            lang="km"
            rows={3}
            onChange={(event) => setDescriptionKm(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-label text-text-secondary">{t("catalog.detail.category")}</span>
          <CategoryChoice
            categories={categories}
            value={categoryId}
            onChange={setCategoryId}
            label={t("catalog.detail.category")}
            noneLabel={t("catalog.detail.categoryNone")}
            className="-mx-5 px-5"
          />
        </div>

        <MoneyAmountField
          id="product-price"
          label={t("catalog.variant.price")}
          value={priceText}
          onChange={setPriceText}
          currency={priceCurrency}
          onCurrencyChange={setPriceCurrency}
          error={priceError}
        />

        {canSetCost ? (
          <MoneyAmountField
            id="product-cost"
            label={t("catalog.variant.cost")}
            value={costText}
            onChange={setCostText}
            currency={costCurrency}
            onCurrencyChange={setCostCurrency}
            hint={t("catalog.variant.costOptional")}
            error={costError}
          />
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-sku" className="text-label text-text-secondary">
            {t("catalog.variant.sku")}
          </Label>
          <Input
            id="product-sku"
            className="h-12"
            value={sku}
            onChange={(event) => setSku(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="product-barcode" className="text-label text-text-secondary">
            {t("catalog.variant.barcode")}
          </Label>
          <Input
            id="product-barcode"
            className="h-12"
            value={barcode}
            onChange={(event) => setBarcode(event.target.value)}
          />
        </div>

        {formError ? (
          <p className="text-caption text-status-danger-text" role="alert">
            {formError}
          </p>
        ) : null}

        <Button className="tap-target h-12 w-full" disabled={saving} onClick={() => void submit()}>
          {saving ? t("catalog.saving") : t("catalog.list.addProduct")}
        </Button>
      </div>
    </BottomSheet>
  );
}
