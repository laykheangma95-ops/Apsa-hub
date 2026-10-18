import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BottomSheet, Spinner } from "@/design-system";
import { MoneyAmountField } from "@/components/products/MoneyAmountField";
import { CategoryChoice } from "@/components/products/CategoryChoice";
import { useBusinessCurrency } from "@/hooks/use-business-currency";
import {
  moneyBindingIsLive,
  reconcileMoneyBinding,
  type MoneyBinding,
} from "@/lib/business-currency";
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
 *
 * Price and cost are entered ONLY in the business currency
 * (organizations.default_currency): the order RPC refuses a product priced in
 * any other currency, so a product saved in the wrong one cannot be sold.
 * See src/lib/business-currency.ts for the rules this follows:
 *
 *   - Until that currency is known for this organization there are no amount
 *     fields and no submit — a loading, retryable error, or permission state
 *     instead. It is never assumed to be USD.
 *   - Amounts are bound to the organization + currency they were typed under.
 *     If either changes (a late response, an organization switch), they are
 *     cleared and the merchant is told; they are never re-read in another
 *     currency.
 *   - Immediately before the create, the server is asked again; a form whose
 *     binding no longer matches does not submit.
 *
 * The payload sent to createCatalogProduct is unchanged in shape.
 */
export function CreateProductSheet({
  open,
  onOpenChange,
  categories,
  canSetCost,
  onCreated,
}: CreateProductSheetProps) {
  const { t } = useTranslation();
  const lookup = useBusinessCurrency(open);
  const [nameKm, setNameKm] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [descriptionKm, setDescriptionKm] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [priceText, setPriceText] = useState("");
  const [costText, setCostText] = useState("");
  // The organization + currency the amounts above were typed under.
  const [binding, setBinding] = useState<MoneyBinding | null>(null);
  const [amountsCleared, setAmountsCleared] = useState<Currency | null>(null);
  const [touched, setTouched] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [costError, setCostError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Bind to the first known currency; on any change of organization or
  // currency, clear what was typed rather than reinterpret it. Adjusting state
  // during render (not in an effect) means no frame ever shows an old amount
  // beside a new currency.
  const reconciled = reconcileMoneyBinding(
    binding,
    lookup.state,
    priceText !== "" || costText !== "",
  );
  if (reconciled.binding !== binding) {
    setBinding(reconciled.binding);
    if (reconciled.clearAmounts && reconciled.binding) {
      setPriceText("");
      setCostText("");
      setPriceError(null);
      setCostError(null);
      setAmountsCleared(reconciled.binding.currency);
    }
  }
  const live = moneyBindingIsLive(binding, lookup.state) ? binding : null;
  // The binding at the latest render, for checks after an await.
  const latestBinding = useRef<MoneyBinding | null>(live);
  latestBinding.current = live;

  const nameError = touched && nameKm.trim() === "" ? t("catalog.detail.nameKmMissing") : null;

  function reset() {
    setNameKm("");
    setNameEn("");
    setDescriptionKm("");
    setCategoryId(null);
    setSku("");
    setBarcode("");
    setPriceText("");
    setCostText("");
    setBinding(null);
    setAmountsCleared(null);
    setTouched(false);
    setPriceError(null);
    setCostError(null);
    setFormError(null);
  }

  async function submit() {
    setTouched(true);
    setFormError(null);

    // No known, current business currency → nothing can be priced or sent.
    const bound = live;
    if (!bound) return;
    const currency = bound.currency;

    const priceAmount = parseMinorUnits(priceText, currency);
    const priceInvalid = priceAmount === null;
    setPriceError(priceInvalid ? t("catalog.variant.invalidPrice") : null);

    let costAmount: number | null = null;
    let costInvalid = false;
    if (canSetCost && costText.trim() !== "") {
      costAmount = parseMinorUnits(costText, currency);
      costInvalid = costAmount === null;
    }
    setCostError(costInvalid ? t("catalog.variant.invalidCost") : null);

    if (nameKm.trim() === "" || priceInvalid || costInvalid || priceAmount === null) return;

    setSaving(true);
    try {
      // Ask the server again right before creating: the create lands in the
      // session's CURRENT organization, so it must still be the one — and the
      // currency — these amounts were typed under.
      const confirmed = await lookup.confirm(bound);
      const current = latestBinding.current;
      if (
        !confirmed ||
        !current ||
        current.organizationId !== bound.organizationId ||
        current.currency !== bound.currency
      ) {
        setFormError(t("catalog.variant.businessCurrency.confirmFailed"));
        return;
      }

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
          priceCurrency: currency,
          costAmount,
          costCurrency: costAmount === null ? null : currency,
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
      footer={
        <Button
          className="tap-target h-12 w-full"
          disabled={saving || !live}
          aria-busy={saving}
          onClick={() => void submit()}
        >
          {saving ? t("catalog.saving") : t("catalog.list.addProduct")}
        </Button>
      }
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

        {live ? (
          <>
            {amountsCleared ? (
              <p
                className="text-caption flex items-start gap-1.5 text-status-warning-text"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  {t("catalog.variant.businessCurrency.changed", { currency: amountsCleared })}
                </span>
              </p>
            ) : null}

            <MoneyAmountField
              id="product-price"
              label={t("catalog.variant.price")}
              value={priceText}
              onChange={setPriceText}
              currency={live.currency}
              currencies={[live.currency]}
              onCurrencyChange={() => {}}
              lockedNote={t("catalog.variant.businessCurrency.locked", { currency: live.currency })}
              error={priceError}
            />

            {canSetCost ? (
              <MoneyAmountField
                id="product-cost"
                label={t("catalog.variant.cost")}
                value={costText}
                onChange={setCostText}
                currency={live.currency}
                currencies={[live.currency]}
                onCurrencyChange={() => {}}
                hint={t("catalog.variant.costOptional")}
                error={costError}
              />
            ) : null}
          </>
        ) : (
          <BusinessCurrencyNotice state={lookup.state.status} onRetry={lookup.retry} />
        )}

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
      </div>
    </BottomSheet>
  );
}

/**
 * What stands in for the price fields while the business currency is not
 * known: never a guessed currency, always a reason and, where it can help, a
 * retry.
 */
function BusinessCurrencyNotice({
  state,
  onRetry,
}: {
  state: "loading" | "denied" | "error" | "ready";
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  if (state === "denied") {
    return (
      <p
        className="text-caption rounded-xl bg-surface-secondary px-3 py-3 text-text-secondary"
        role="status"
      >
        {t("catalog.variant.businessCurrency.denied")}
      </p>
    );
  }

  if (state === "error") {
    return (
      <div
        className="flex flex-col items-start gap-2 rounded-xl bg-status-danger-soft px-3 py-3"
        role="alert"
      >
        <p className="text-caption flex items-start gap-1.5 text-status-danger-text">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t("catalog.variant.businessCurrency.error")}</span>
        </p>
        <Button type="button" variant="outline" className="tap-target h-11" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  return (
    <p
      className="text-caption flex items-center gap-2 rounded-xl bg-surface-secondary px-3 py-3 text-text-secondary"
      role="status"
      aria-live="polite"
    >
      <Spinner />
      <span>{t("catalog.variant.businessCurrency.loading")}</span>
    </p>
  );
}
