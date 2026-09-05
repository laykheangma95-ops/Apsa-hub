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
import { BottomSheet, CurrencyInput } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { createRealDelivery, type CreateRealDeliveryInput } from "@/lib/api";
import { classifyDeliveryError, type RealDeliveryDetail } from "@/lib/deliveries";
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
  onCreated: (delivery: RealDeliveryDetail) => void;
}

export function CreateDeliverySheet({
  open,
  onOpenChange,
  orderId,
  onCreated,
}: CreateDeliverySheetProps) {
  const { t } = useTranslation();

  const [providerName, setProviderName] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [codEnabled, setCodEnabled] = useState(false);
  const [codCents, setCodCents] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<CreateFailure | null>(null);

  function reset() {
    setProviderName("");
    setProviderKey("");
    setTrackingNumber("");
    setCodEnabled(false);
    setCodCents(0);
    setSubmitting(false);
    setFailure(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function submit() {
    const name = providerName.trim();
    if (!name) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const input: CreateRealDeliveryInput = { orderId, providerName: name };
      const key = providerKey.trim();
      if (key) input.providerKey = key;
      const tracking = trackingNumber.trim();
      if (tracking) input.externalTrackingNumber = tracking;
      if (codEnabled && codCents > 0) input.codAmountMinor = codCents;
      const detail = await createRealDelivery(input);
      onCreated(detail);
      handleOpenChange(false);
    } catch (error) {
      setFailure(classifyCreateFailure(error));
      setSubmitting(false);
    }
  }

  const failureCopy: Record<CreateFailure, { title: string; body: string }> = {
    permission: { title: t("delivery.create.permission.title"), body: t("delivery.create.permission.body") },
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
              <CurrencyInput
                id="delivery-create-cod"
                label={t("delivery.create.cod")}
                value={codCents}
                onChange={setCodCents}
              />
              <p className="text-caption text-text-muted">{t("delivery.create.codHint")}</p>
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
          disabled={submitting || providerName.trim().length === 0}
          onClick={() => void submit()}
        >
          {submitting ? t("delivery.create.creating") : t("delivery.create.submit")}
        </Button>
      </div>
    </BottomSheet>
  );
}
