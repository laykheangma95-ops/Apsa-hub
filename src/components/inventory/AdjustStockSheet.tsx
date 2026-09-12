import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BottomSheet } from "@/design-system";
import { LocationChoice } from "@/components/inventory/LocationChoice";
import {
  canSubmitAdjustment,
  classifyInventoryError,
  formatMovementDelta,
  inventoryErrorKey,
  parseQuantity,
  recordInventoryMovement,
  type InventoryLocation,
} from "@/lib/inventory";

interface AdjustStockSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  variantId: string;
  /** For the sheet's own heading — identity only. */
  variantLabel: string;
  /** Current on-hand, so the merchant can see what the delta lands on. */
  quantityOnHand: number;
  locations: readonly InventoryLocation[];
  /** Called after the server confirmed the movement. Never on failure. */
  onRecorded: () => void;
}

/**
 * Correct stock by hand — a signed delta, with a reason, on the record.
 *
 * Like every other stock change in APSA this appends a movement rather than
 * writing a quantity: `manual_adjustment` with a `quantity_delta` of -3 records
 * that three units went missing, and the balance follows from the ledger. There
 * is no setStock to reach for, here or in the server.
 *
 * The reason is genuinely required, not merely encouraged. The server refuses a
 * manual_adjustment without one, and — before it inserts anything — writes a
 * mandatory audit record through auditLogRequired(): if that write fails, the
 * adjustment is blocked. This form disables its own submit on a blank reason so
 * the merchant finds out here rather than after a round trip, but the server's
 * check is the one that counts and this form cannot bypass it.
 */
export function AdjustStockSheet({
  open,
  onOpenChange,
  productId,
  variantId,
  variantLabel,
  quantityOnHand,
  locations,
  onRecorded,
}: AdjustStockSheetProps) {
  const { t } = useTranslation();
  const [deltaText, setDeltaText] = useState("");
  const [reason, setReason] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deltaError, setDeltaError] = useState<string | null>(null);

  const activeLocations = locations.filter((location) => location.status === "active");

  useEffect(() => {
    if (!open) return;
    setDeltaText("");
    setReason("");
    setLocationId(null);
    setFormError(null);
    setDeltaError(null);
  }, [open, variantId]);

  // Signed: a negative delta writes stock down, a positive one writes it up.
  // Zero is not an adjustment and the server refuses it.
  const delta = parseQuantity(deltaText, true);
  const deltaValid = delta !== null && delta !== 0;
  const reasonProvided = reason.trim() !== "";
  // One pure rule, shared with the tests: a non-zero delta AND a non-blank
  // reason. Whitespace is not a reason.
  const canSubmit = canSubmitAdjustment(deltaText, reason) && !saving;

  async function submit() {
    if (!deltaValid) {
      setDeltaError(t("stockAdjustment.invalidDelta"));
      return;
    }
    // Belt and braces alongside the disabled button: a blank reason must never
    // leave this form, and the server refuses it regardless.
    if (!reasonProvided) return;

    setDeltaError(null);
    setFormError(null);
    setSaving(true);
    try {
      await recordInventoryMovement({
        productId,
        variantId,
        locationId,
        quantityDelta: delta,
        movementType: "manual_adjustment",
        reason: reason.trim(),
      });
      onRecorded();
      onOpenChange(false);
    } catch (err) {
      // Includes the audit-blocked case, which reads as its own sentence: the
      // stock did NOT change, and the merchant is told why rather than being
      // shown a generic retry.
      setFormError(t(inventoryErrorKey(classifyInventoryError(err))));
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("stockAdjustment.title")}
      description={variantLabel}
      snap="full"
      className="lg:max-w-[520px]"
    >
      <div className="space-y-4">
        <p className="text-body-sm rounded-2xl bg-surface-secondary px-4 py-3 text-text-secondary">
          {t("stockAdjustment.currentOnHand")}{" "}
          <span className="text-financial tnum text-text-primary">{quantityOnHand}</span>
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="adjust-delta" className="text-label text-text-secondary">
            {t("stockAdjustment.delta")}
          </Label>
          <Input
            id="adjust-delta"
            inputMode="text"
            className="tnum h-12"
            value={deltaText}
            disabled={saving}
            aria-invalid={deltaError ? true : undefined}
            aria-describedby="adjust-delta-hint"
            onChange={(event) => setDeltaText(event.target.value)}
          />
          <span id="adjust-delta-hint" className="text-caption text-text-secondary">
            {t("stockAdjustment.deltaHint")}
          </span>
          {/*
           * The resulting balance, shown plainly — including when it lands
           * below zero. A negative result is not blocked and not hidden: the
           * ledger allows it and the merchant needs to see it before agreeing
           * to it.
           */}
          {deltaValid ? (
            <p className="text-caption text-text-secondary" role="status">
              {t("stockAdjustment.resultPreview", {
                delta: formatMovementDelta(delta),
                result: quantityOnHand + delta,
              })}
            </p>
          ) : null}
          {deltaError ? (
            <p className="text-caption text-status-danger-text" role="alert">
              {deltaError}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="adjust-reason" className="text-label text-text-secondary">
            {t("stockAdjustment.reason")}
          </Label>
          <Textarea
            id="adjust-reason"
            value={reason}
            disabled={saving}
            rows={3}
            aria-required
            aria-describedby="adjust-reason-hint"
            onChange={(event) => setReason(event.target.value)}
          />
          <span id="adjust-reason-hint" className="text-caption text-text-secondary">
            {t("stockAdjustment.reasonHint")}
          </span>
        </div>

        {activeLocations.length > 0 ? (
          <LocationChoice
            locations={activeLocations}
            value={locationId}
            onChange={setLocationId}
            disabled={saving}
            label={t("stockAdjustment.location")}
            noneLabel={t("stockAdjustment.noLocation")}
            className="mx-0 px-0"
          />
        ) : null}

        {formError ? (
          <p className="text-caption text-status-danger-text" role="alert">
            {formError}
          </p>
        ) : null}

        <Button
          className="tap-target h-12 w-full"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {saving ? t("inventory.saving") : t("stockAdjustment.confirm")}
        </Button>
        {!reasonProvided ? (
          <p className="text-caption text-center text-text-secondary" role="status">
            {t("stockAdjustment.reasonRequiredNote")}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
