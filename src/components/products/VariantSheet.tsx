import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet } from "@/design-system";
import { MoneyAmountField } from "@/components/products/MoneyAmountField";
import {
  catalogErrorKey,
  classifyCatalogError,
  createCatalogVariant,
  formatMinorUnitsForInput,
  parseMinorUnits,
  updateCatalogVariant,
  variantFieldAccess,
  visibleVariantCost,
  type CatalogVariant,
  type VariantPermissions,
} from "@/lib/catalog";
import type { Currency } from "@/types";

interface VariantSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  /** Absent for "add variant"; present for "edit variant". */
  variant?: CatalogVariant | undefined;
  permissions: VariantPermissions;
  onSaved: () => void;
}

interface FormState {
  name: string;
  sku: string;
  barcode: string;
  priceText: string;
  priceCurrency: Currency;
  costText: string;
  costCurrency: Currency;
  weight: string;
}

function emptyForm(): FormState {
  return {
    name: "",
    sku: "",
    barcode: "",
    priceText: "",
    priceCurrency: "USD",
    costText: "",
    costCurrency: "USD",
    weight: "",
  };
}

function formFor(variant: CatalogVariant, canViewCost: boolean): FormState {
  // Masked through visibleVariantCost — never read variant.cost directly —
  // so a revoked products.view_cost keeps a stale cached cost out of form
  // state entirely, not just out of what's rendered. The form then shows an
  // empty, locked cost and sends no cost field at all — a withheld value is
  // never reconstructed, defaulted to zero, or echoed back as a change.
  const cost = visibleVariantCost(variant, canViewCost);
  return {
    name: variant.name,
    sku: variant.sku ?? "",
    barcode: variant.barcode ?? "",
    priceText: formatMinorUnitsForInput(variant.price.amount, variant.price.currency),
    priceCurrency: variant.price.currency,
    costText: cost ? formatMinorUnitsForInput(cost.amount, cost.currency) : "",
    costCurrency: cost?.currency ?? variant.price.currency,
    weight: variant.weightGrams === null ? "" : String(variant.weightGrams),
  };
}

function parseWeight(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const grams = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(grams) ? grams : "invalid";
}

export function VariantSheet({
  open,
  onOpenChange,
  productId,
  variant,
  permissions,
  onSaved,
}: VariantSheetProps) {
  const { t } = useTranslation();
  const isEdit = variant !== undefined;
  const [form, setForm] = useState<FormState>(() =>
    variant ? formFor(variant, permissions.canViewCost) : emptyForm(),
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    price?: string;
    cost?: string;
    weight?: string;
  }>({});

  // Re-seed when the sheet opens on a different variant, so an edit never
  // starts from the previous row's values. Also re-seeds on a mid-session
  // products.view_cost change, so a sheet left open across a revocation
  // strips any already-loaded cost out of form state immediately rather
  // than leaving it to be masked only by the costVisible render-gate below.
  useEffect(() => {
    if (!open) return;
    setForm(variant ? formFor(variant, permissions.canViewCost) : emptyForm());
    setFormError(null);
    setFieldErrors({});
  }, [open, variant, permissions.canViewCost]);

  /*
   * One pure decision, shared with the tests: which fields this form offers.
   * A locked price is never resent, because the server reads any price key in
   * the patch as a price change requiring products.update_price.
   */
  const { basicEditable, priceEditable, costEditable, costVisible } = variantFieldAccess(
    permissions,
    isEdit,
  );

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  async function submit() {
    const errors: { price?: string; cost?: string; weight?: string } = {};

    let priceAmount: number | null = null;
    if (priceEditable) {
      priceAmount = parseMinorUnits(form.priceText, form.priceCurrency);
      if (priceAmount === null) errors.price = t("catalog.variant.invalidPrice");
    }

    let costAmount: number | null = null;
    if (costEditable && form.costText.trim() !== "") {
      costAmount = parseMinorUnits(form.costText, form.costCurrency);
      if (costAmount === null) errors.cost = t("catalog.variant.invalidCost");
    }

    const weight = parseWeight(form.weight);
    if (weight === "invalid") errors.weight = t("catalog.variant.invalidWeight");

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    setFormError(null);
    try {
      if (isEdit) {
        await updateCatalogVariant({
          variantId: variant.id,
          ...(basicEditable
            ? {
                name: form.name.trim(),
                sku: form.sku.trim() === "" ? null : form.sku.trim(),
                barcode: form.barcode.trim() === "" ? null : form.barcode.trim(),
                weightGrams: weight === "invalid" ? null : weight,
              }
            : {}),
          ...(priceEditable && priceAmount !== null
            ? { priceAmount, priceCurrency: form.priceCurrency }
            : {}),
          ...(costEditable
            ? { costAmount, costCurrency: costAmount === null ? null : form.costCurrency }
            : {}),
        });
      } else {
        await createCatalogVariant(productId, {
          name: form.name.trim(),
          sku: form.sku.trim() === "" ? null : form.sku.trim(),
          barcode: form.barcode.trim() === "" ? null : form.barcode.trim(),
          priceAmount: priceAmount ?? 0,
          priceCurrency: form.priceCurrency,
          costAmount,
          costCurrency: costAmount === null ? null : form.costCurrency,
          weightGrams: weight === "invalid" ? null : weight,
        });
      }
      onSaved();
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
      onOpenChange={onOpenChange}
      title={isEdit ? t("catalog.variant.edit") : t("catalog.variant.create")}
      snap="full"
      className="lg:max-w-[520px]"
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="variant-name" className="text-label text-text-secondary">
            {t("catalog.variant.name")}
          </Label>
          <Input
            id="variant-name"
            className="h-12"
            value={form.name}
            disabled={!basicEditable}
            onChange={(event) => set("name", event.target.value)}
          />
          <span className="text-caption text-text-secondary">{t("catalog.variant.nameHint")}</span>
        </div>

        <MoneyAmountField
          id="variant-price"
          label={t("catalog.variant.price")}
          value={form.priceText}
          onChange={(next) => set("priceText", next)}
          currency={form.priceCurrency}
          onCurrencyChange={(next) => set("priceCurrency", next)}
          disabled={!priceEditable}
          {...(priceEditable ? {} : { lockedNote: t("catalog.variant.priceLocked") })}
          error={fieldErrors.price ?? null}
        />

        {/*
         * Cost appears only when the server actually sent one and this member
         * may change it. Without products.view_cost the value is not in the
         * response at all, so there is nothing to show and nothing to send.
         */}
        {costVisible ? (
          <MoneyAmountField
            id="variant-cost"
            label={t("catalog.variant.cost")}
            value={form.costText}
            onChange={(next) => set("costText", next)}
            currency={form.costCurrency}
            onCurrencyChange={(next) => set("costCurrency", next)}
            hint={t("catalog.variant.costOptional")}
            disabled={!costEditable}
            {...(costEditable ? {} : { lockedNote: t("catalog.variant.costLocked") })}
            error={fieldErrors.cost ?? null}
          />
        ) : (
          <p className="text-caption text-text-secondary">{t("catalog.variant.costWithheld")}</p>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="variant-sku" className="text-label text-text-secondary">
            {t("catalog.variant.sku")}
          </Label>
          <Input
            id="variant-sku"
            className="h-12"
            value={form.sku}
            disabled={!basicEditable}
            onChange={(event) => set("sku", event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="variant-barcode" className="text-label text-text-secondary">
            {t("catalog.variant.barcode")}
          </Label>
          <Input
            id="variant-barcode"
            className="h-12"
            value={form.barcode}
            disabled={!basicEditable}
            onChange={(event) => set("barcode", event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="variant-weight" className="text-label text-text-secondary">
            {t("catalog.variant.weight")}
          </Label>
          <Input
            id="variant-weight"
            inputMode="numeric"
            className="tnum h-12"
            value={form.weight}
            disabled={!basicEditable}
            aria-invalid={fieldErrors.weight ? true : undefined}
            onChange={(event) => set("weight", event.target.value)}
          />
          {fieldErrors.weight ? (
            <p className="text-caption text-status-danger-text" role="alert">
              {fieldErrors.weight}
            </p>
          ) : null}
        </div>

        {formError ? (
          <p className="text-caption text-status-danger-text" role="alert">
            {formError}
          </p>
        ) : null}

        <Button className="tap-target h-12 w-full" disabled={saving} onClick={() => void submit()}>
          {saving ? t("catalog.saving") : t("catalog.save")}
        </Button>
      </div>
    </BottomSheet>
  );
}
