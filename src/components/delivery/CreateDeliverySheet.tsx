/**
 * Create-delivery flow for the production Delivery domain (Delivery UI
 * Production Integration phase). Reached from the real Order detail screen
 * (src/routes/app.orders.$id.tsx) for an eligible confirmed order.
 *
 * Manual-provider path only — src/api/deliveries.ts also accepts a
 * providerId, but no list-providers endpoint exists yet to offer a picker
 * for it, and inventing one is out of scope for a UI+API wiring phase (see
 * the task's "do not invent new provider architecture").
 *
 * Client never supplies organization_id or user_id — createRealDelivery()'s
 * input (src/lib/api/index.ts) has no field for either; the server derives
 * both from the session. COD amount is operational only: it is never read
 * as, or converted into, an order payment status.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { createRealDelivery, type CreateRealDeliveryInput } from "@/lib/api";
import { classifyDeliveryError, type RealDeliveryDetail } from "@/lib/deliveries";
import { codDiffersFromTotal, parseCodAmount } from "@/lib/delivery-fee";
import { MINOR_UNIT_DIGITS, formatMoney } from "@/lib/money";
import type { Money } from "@/types";
import { cn } from "@/lib/utils";

type CreateFailure = "permission" | "invalidOrder" | "duplicateActive" | "generic";

function classifyCreateFailure(error: unknown): CreateFailure {
  if (classifyDeliveryError(error) === "forbidden") return "permission";
  const message = error instanceof Error ? error.message : "";
  if (/already has an active delivery/i.test(message)) return "duplicateActive";
  if (/confirmed order|fulfillment is already terminal/i.test(message)) return "invalidOrder";
  return "generic";
}

interface CreateDeliverySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  /**
   * The order's server-derived total (goods - discount + delivery fee), shown
   * beside a COD amount that differs from it. Display only — COD is never
   * derived from, or written back into, the order's money.
   *
   * Required: its CURRENCY is the COD amount's currency. The server stores
   * cod_currency as the order's currency, so the amount must be typed in it —
   * there is no honest COD field without knowing which currency that is.
   */
  orderTotal: Money;
  onCreated: (delivery: RealDeliveryDetail) => void;
}

export function CreateDeliverySheet({
  open,
  onOpenChange,
  orderId,
  orderTotal,
  onCreated,
}: CreateDeliverySheetProps) {
  const { t } = useTranslation();

  const [providerName, setProviderName] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [codEnabled, setCodEnabled] = useState(false);
  // Kept as text so a half-typed "1." is never rounded; parsed on use, in the
  // order's own currency.
  const [codText, setCodText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<CreateFailure | null>(null);

  function reset() {
    setProviderName("");
    setProviderKey("");
    setTrackingNumber("");
    setCodEnabled(false);
    setCodText("");
    setSubmitting(false);
    setFailure(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const codCurrency = orderTotal.currency;
  const codMinor = codEnabled ? parseCodAmount(codText, codCurrency) : 0;
  const codInvalid = codEnabled && codMinor === null;

  async function submit() {
    const name = providerName.trim();
    if (!name || codInvalid) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const input: CreateRealDeliveryInput = { orderId, providerName: name };
      const key = providerKey.trim();
      if (key) input.providerKey = key;
      const tracking = trackingNumber.trim();
      if (tracking) input.externalTrackingNumber = tracking;
      if (codEnabled && codMinor !== null && codMinor > 0) input.codAmountMinor = codMinor;
      const detail = await createRealDelivery(input);
      onCreated(detail);
      handleOpenChange(false);
    } catch (error) {
      setFailure(classifyCreateFailure(error));
      setSubmitting(false);
    }
  }

  const failureCopy: Record<CreateFailure, { title: string; body: string }> = {
    permission: {
      title: t("delivery.create.permission.title"),
      body: t("delivery.create.permission.body"),
    },
    invalidOrder: {
      title: t("delivery.create.invalidOrder.title"),
      body: t("delivery.create.invalidOrder.body"),
    },
    duplicateActive: {
      title: t("delivery.create.duplicateActive.title"),
      body: t("delivery.create.duplicateActive.body"),
    },
    generic: { title: t("delivery.create.error.title"), body: t("delivery.create.error.body") },
  };

  return (
    <BottomSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={t("delivery.create.title")}
      snap="half"
    >
      <div className="space-y-4 pb-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="delivery-provider-name" className="text-label text-text-secondary">
            {t("delivery.create.providerName")}
          </Label>
          <Input
            id="delivery-provider-name"
            className="h-12"
            placeholder={t("delivery.create.providerNamePlaceholder")}
            value={providerName}
            onChange={(e) => setProviderName(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="delivery-provider-key" className="text-label text-text-secondary">
            {t("delivery.create.providerKey")}
          </Label>
          <Input
            id="delivery-provider-key"
            className="h-12"
            value={providerKey}
            onChange={(e) => setProviderKey(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="delivery-tracking-number" className="text-label text-text-secondary">
            {t("delivery.create.trackingNumber")}
          </Label>
          <Input
            id="delivery-tracking-number"
            className="h-12 tnum"
            value={trackingNumber}
            onChange={(e) => setTrackingNumber(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-label text-text-secondary">{t("delivery.create.cod")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={codEnabled}
              aria-label={t("delivery.create.cod")}
              onClick={() => setCodEnabled((v) => !v)}
              className={cn(
                "tap-target flex w-14 items-center rounded-full px-1",
                codEnabled ? "bg-action-primary" : "bg-surface-secondary",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-6 rounded-full bg-surface-primary shadow transition-transform",
                  codEnabled ? "translate-x-6" : "translate-x-0",
                )}
              />
            </button>
          </div>
          {codEnabled ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="delivery-create-cod" className="text-label text-text-secondary">
                  {t("delivery.create.codAmount", { currency: codCurrency })}
                </Label>
                <Input
                  id="delivery-create-cod"
                  inputMode={MINOR_UNIT_DIGITS[codCurrency] === 0 ? "numeric" : "decimal"}
                  autoComplete="off"
                  className="text-financial h-12"
                  value={codText}
                  placeholder={MINOR_UNIT_DIGITS[codCurrency] === 0 ? "0" : "0.00"}
                  aria-invalid={codInvalid ? true : undefined}
                  aria-describedby={
                    codInvalid ? "delivery-create-cod-error" : "delivery-create-cod-readback"
                  }
                  onChange={(e) => setCodText(e.target.value)}
                />
                {codInvalid ? (
                  <p
                    id="delivery-create-cod-error"
                    role="alert"
                    className="text-caption text-status-danger-text"
                  >
                    {t(
                      MINOR_UNIT_DIGITS[codCurrency] === 0
                        ? "delivery.create.codInvalidWhole"
                        : "delivery.create.codInvalidDecimal",
                      { currency: codCurrency },
                    )}
                  </p>
                ) : codMinor !== null && codMinor > 0 ? (
                  // Read back in the order's currency, with its own symbol, so a
                  // decimal-place or currency mistake is visible before submit.
                  <p id="delivery-create-cod-readback" className="text-caption text-text-secondary">
                    {t("delivery.create.codReadback", {
                      amount: formatMoney({ amount: codMinor, currency: codCurrency }),
                    })}
                  </p>
                ) : null}
              </div>
              <p className="text-caption text-text-muted">{t("delivery.create.codHint")}</p>
              {codMinor !== null &&
              codMinor > 0 &&
              codDiffersFromTotal({ amount: codMinor, currency: codCurrency }, orderTotal) ? (
                <p className="text-caption text-status-warning-text">
                  {t("deliveryFee.codDiffers", { total: formatMoney(orderTotal) })}
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        {failure ? (
          <OperationalState
            tone="danger"
            title={failureCopy[failure].title}
            body={failureCopy[failure].body}
          />
        ) : null}

        <Button
          className="tap-target h-12 w-full"
          disabled={submitting || providerName.trim().length === 0 || codInvalid}
          onClick={() => void submit()}
        >
          {submitting ? t("delivery.create.creating") : t("delivery.create.submit")}
        </Button>
      </div>
    </BottomSheet>
  );
}
