import { useEffect, useRef, useState } from "react";
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
  isCreateBindingChanged,
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
 *   - The create carries the user, organization and currency it was initiated
 *     under; the server refuses it, before any write, if the session no longer
 *     matches (src/server/products/service.ts createProduct).
 *
 * Draft and request lifecycle. Every draft has an instance number that moves
 * on reset, close/open, unmount, any principal change (so A → B → A is a new
 * tenure, not "the same organization") and any re-binding of the amounts.
 * Each save attempt records the draft it was started for; when that draft is
 * gone, the attempt's late confirmation, success or failure changes nothing on
 * screen — it never submits a discarded draft, never resets or closes a newer
 * one, and never shows its error over it. One attempt runs at a time.
 *
 * Edit lock. The payload is read when Save is pressed, so from then until the
 * attempt settles every field that feeds it is disabled, and every setter
 * refuses changes (`editable`), so no input path can alter a draft that is
 * already on its way — an edit made then would be dropped by the success that
 * closes the sheet. A failure or refusal unlocks the draft exactly as it was
 * sent; a new draft (close/reopen, a new tenure) is never locked.
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

  // Draft-instance identity and the save attempt in flight (see header).
  const draft = useRef(0);
  const request = useRef<{ draft: number } | null>(null);
  const mounted = useRef(true);
  const principal = lookup.principal;
  const principalKey = principal ? `${principal.userId}:${principal.organizationId}` : null;
  const seenPrincipal = useRef(principalKey);
  const seenOpen = useRef(open);

  /**
   * Start a new draft instance. A save still in flight for the old one is
   * abandoned; `announce` tells the merchant it was not saved (used when the
   * business moved under it, not when they closed the sheet themselves).
   */
  function discardDraft(announce = false) {
    draft.current += 1;
    if (request.current) {
      request.current = null;
      setSaving(false);
      if (announce) setFormError(t("catalog.variant.businessCurrency.confirmFailed"));
    }
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      draft.current += 1;
      request.current = null;
    };
  }, []);

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
    discardDraft(true);
    setBinding(reconciled.binding);
    if (reconciled.clearAmounts && reconciled.binding) {
      setPriceText("");
      setCostText("");
      setPriceError(null);
      setCostError(null);
      setAmountsCleared(reconciled.binding.currency);
    }
  }
  // A new tenure — another user, another organization, or back again — or an
  // open/close the parent drove makes this a new draft. Another user also
  // never sees what the previous one typed.
  if (seenOpen.current !== open) {
    seenOpen.current = open;
    discardDraft();
  }
  if (seenPrincipal.current !== principalKey) {
    const previousUser = seenPrincipal.current?.split(":")[0] ?? null;
    seenPrincipal.current = principalKey;
    if (previousUser !== null && previousUser !== principal?.userId) reset();
    else discardDraft(true);
  }
  const live = moneyBindingIsLive(binding, lookup.state) ? binding : null;
  // The binding at the latest render, for checks after an await.
  const latestBinding = useRef<MoneyBinding | null>(live);
  latestBinding.current = live;

  // While an attempt is out for this draft, nothing may change it (see header).
  // Checked on the ref, not `saving`, so even an event dispatched before the
  // re-render is refused.
  const locked = saving;
  function editable<T>(set: (next: T) => void) {
    return (next: T) => {
      if (request.current) return;
      set(next);
    };
  }

  const nameError = touched && nameKm.trim() === "" ? t("catalog.detail.nameKmMissing") : null;

  function reset() {
    discardDraft();
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
    // One attempt at a time; a double click does not start a second create.
    if (request.current) return;
    setTouched(true);
    setFormError(null);

    // No known, current business currency → nothing can be priced or sent.
    const bound = live;
    if (!bound || !principal || principal.organizationId !== bound.organizationId) return;
    const currency = bound.currency;
    const startedFor = principalKey;

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

    const mine = { draft: draft.current };
    request.current = mine;
    // Still the attempt for the draft on screen? False once that draft was
    // replaced, closed, reopened, remounted or re-tenured.
    const isCurrent = () =>
      mounted.current && request.current === mine && draft.current === mine.draft;

    setSaving(true);
    try {
      // Ask the server again right before creating: the create lands in the
      // session's CURRENT organization, so it must still be the one — and the
      // currency — these amounts were typed under.
      const confirmed = await lookup.confirm(bound);
      if (!isCurrent()) return;
      const latest = latestBinding.current;
      if (
        !confirmed ||
        !latest ||
        latest.organizationId !== bound.organizationId ||
        latest.currency !== bound.currency
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
        expected: { userId: principal.userId, organizationId: bound.organizationId, currency },
      });
      if (!isCurrent()) {
        // The product exists, but its draft is gone: refresh the catalog it
        // belongs to (only if that is still this principal's), touch nothing else.
        if (seenPrincipal.current === startedFor) onCreated(product);
        return;
      }
      onCreated(product);
      reset();
      onOpenChange(false);
    } catch (err) {
      if (!isCurrent()) return;
      setFormError(
        isCreateBindingChanged(err)
          ? t("catalog.variant.businessCurrency.confirmFailed")
          : t(catalogErrorKey(classifyCatalogError(err))),
      );
    } finally {
      if (request.current === mine) {
        request.current = null;
        if (mounted.current) setSaving(false);
      }
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
            disabled={locked}
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => editable(setNameKm)(event.target.value)}
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
            disabled={locked}
            onChange={(event) => editable(setNameEn)(event.target.value)}
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
            disabled={locked}
            onChange={(event) => editable(setDescriptionKm)(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-label text-text-secondary">{t("catalog.detail.category")}</span>
          <CategoryChoice
            categories={categories}
            value={categoryId}
            onChange={editable(setCategoryId)}
            disabled={locked}
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
              onChange={editable(setPriceText)}
              disabled={locked}
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
                onChange={editable(setCostText)}
                disabled={locked}
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
            disabled={locked}
            onChange={(event) => editable(setSku)(event.target.value)}
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
            disabled={locked}
            onChange={(event) => editable(setBarcode)(event.target.value)}
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
