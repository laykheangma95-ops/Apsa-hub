import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet, Chip, ChipRow } from "@/design-system";
import { LocationChoice } from "@/components/inventory/LocationChoice";
import {
  RECEIVE_MOVEMENT_TYPES,
  canSubmitReceipt,
  classifyInventoryError,
  inventoryErrorKey,
  parseQuantity,
  recordInventoryMovement,
  type InventoryLocation,
  type ReceiveMovementType,
} from "@/lib/inventory";

interface ReceiveStockSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  variantId: string;
  /** For the sheet's own heading — identity only, never a stock figure. */
  variantLabel: string;
  locations: readonly InventoryLocation[];
  /** Called after the server confirmed the movement. Never on failure. */
  onRecorded: () => void;
}

/**
 * Receive stock into the ledger.
 *
 * This sheet never writes a quantity. It records a MOVEMENT — one append-only
 * row — and the server recomputes the balance from the ledger. There is no
 * "set stock to N" path here or anywhere else in this UI, by design: a stock
 * count that can be overwritten loses the history that explains it.
 *
 * Only the two receive movement types exist here (`restock` and `initial`).
 * `sale` and `return` are written by the Order domain inside the order's own
 * transaction (migration 026), not by a human through this sheet, and
 * `manual_adjustment` has its own sheet because it demands a reason and a
 * mandatory audit record.
 *
 * Quantity is positive only: receiving negative stock is a correction, and a
 * correction is an adjustment — with a reason attached. The server enforces
 * the movement-type→permission mapping regardless of what this form sends.
 */
export function ReceiveStockSheet({
  open,
  onOpenChange,
  productId,
  variantId,
  variantLabel,
  locations,
  onRecorded,
}: ReceiveStockSheetProps) {
  const { t } = useTranslation();
  const [movementType, setMovementType] = useState<ReceiveMovementType>("restock");
  const [quantityText, setQuantityText] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [quantityError, setQuantityError] = useState<string | null>(null);

  const activeLocations = locations.filter((location) => location.status === "active");

  // Re-seed whenever the sheet opens on a different variant, so a receipt
  // never starts from the previous row's numbers.
  useEffect(() => {
    if (!open) return;
    setMovementType("restock");
    setQuantityText("");
    setLocationId(null);
    setFormError(null);
    setQuantityError(null);
  }, [open, variantId]);

  // One pure rule, shared with the tests: a receipt needs a whole number
  // above zero. `quantity` is re-parsed for the value itself.
  const quantityValid = canSubmitReceipt(quantityText);
  const quantity = parseQuantity(quantityText, false);

  async function submit() {
    // Re-derived from the parsed value rather than the boolean, so the
    // positive-integer guarantee below is the compiler's as well as the rule's.
    if (quantity === null || quantity <= 0) {
      setQuantityError(t("receiveStock.invalidQuantity"));
      return;
    }
    setQuantityError(null);
    setFormError(null);
    setSaving(true);
    try {
      await recordInventoryMovement({
        productId,
        variantId,
        locationId,
        // Positive by construction: parseQuantity refused a sign and the guard
        // above refused zero. The server checks both again.
        quantityDelta: quantity,
        movementType,
        reason: null,
      });
      onRecorded();
      onOpenChange(false);
    } catch (err) {
      // The server's answer is reported as itself. A refusal is never dressed
      // up as a success, and no quantity is shown as changed when it was not.
      setFormError(t(inventoryErrorKey(classifyInventoryError(err))));
    } finally {
      setSaving(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("receiveStock.title")}
      description={variantLabel}
      snap="full"
      className="lg:max-w-[520px]"
    >
      <div className="space-y-4">
        <ChipRow label={t("receiveStock.movementType")} className="mx-0 px-0">
          {RECEIVE_MOVEMENT_TYPES.map((option) => (
            <Chip
              key={option}
              selected={movementType === option}
              disabled={saving}
              onClick={() => setMovementType(option)}
            >
              {t(`receiveStock.type.${option}`)}
            </Chip>
          ))}
        </ChipRow>
        <p className="text-caption px-1 text-text-secondary">
          {t(`receiveStock.typeHint.${movementType}`)}
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="receive-quantity" className="text-label text-text-secondary">
            {t("receiveStock.quantity")}
          </Label>
          <Input
            id="receive-quantity"
            inputMode="numeric"
            className="tnum h-12"
            value={quantityText}
            disabled={saving}
            aria-invalid={quantityError ? true : undefined}
            aria-describedby="receive-quantity-hint"
            onChange={(event) => setQuantityText(event.target.value)}
          />
          <span id="receive-quantity-hint" className="text-caption text-text-secondary">
            {t("receiveStock.quantityHint")}
          </span>
          {quantityError ? (
            <p className="text-caption text-status-danger-text" role="alert">
              {quantityError}
            </p>
          ) : null}
        </div>

        {/*
         * Offered only when this organization actually has locations. Nothing
         * in the ledger requires one (migration 021's location_id is nullable),
         * so an empty picker would be a control over a choice that does not
         * exist rather than a missing answer.
         */}
        {activeLocations.length > 0 ? (
          <LocationChoice
            locations={activeLocations}
            value={locationId}
            onChange={setLocationId}
            disabled={saving}
            label={t("receiveStock.location")}
            noneLabel={t("receiveStock.noLocation")}
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
          disabled={saving || !quantityValid}
          onClick={() => void submit()}
        >
          {saving ? t("inventory.saving") : t("receiveStock.confirm")}
        </Button>
      </div>
    </BottomSheet>
  );
}
