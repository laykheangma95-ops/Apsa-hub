/**
 * "Ship this order" intent + destination fields for order creation.
 *
 * Shipping is an EXPLICIT choice. Prefilled customer name/phone (Inbox, or a
 * chosen customer) sit dormant behind the switch: they never turn a pickup
 * order into a shipment, and the destination is sent only when the merchant
 * turns shipping on. Presentation only — the server still validates.
 */
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { ShippingDestinationFields } from "@/components/orders/ShippingDestinationFields";
import type { ShippingDestinationValue } from "@/lib/shipping-destination";

export interface ShippingIntentSectionProps {
  intent: boolean;
  onIntentChange: (next: boolean) => void;
  value: ShippingDestinationValue;
  onChange: (next: ShippingDestinationValue) => void;
  idPrefix: string;
  disabled?: boolean;
}

export function ShippingIntentSection({
  intent,
  onIntentChange,
  value,
  onChange,
  idPrefix,
  disabled = false,
}: ShippingIntentSectionProps) {
  const { t } = useTranslation();
  const switchId = `${idPrefix}-ship-intent`;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={switchId} className="text-label text-text-secondary">
            {t("shipping.intent")}
          </label>
          <p className="text-caption text-text-muted">{t("shipping.intentHint")}</p>
        </div>
        <Switch
          id={switchId}
          checked={intent}
          disabled={disabled}
          onCheckedChange={onIntentChange}
          aria-label={t("shipping.intent")}
        />
      </div>
      {intent ? (
        <>
          <ShippingDestinationFields
            idPrefix={idPrefix}
            value={value}
            onChange={onChange}
            disabled={disabled}
          />
          {!value.name.trim() || !value.address.trim() ? (
            <p className="text-caption text-text-muted">{t("shipping.intentNeedsDestination")}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
