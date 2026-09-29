/**
 * Reusable shipping-destination field group (name / phone / address).
 *
 * Used both when creating an order (an optional destination captured up front)
 * and when confirming/correcting a destination before a parcel label prints.
 * It is presentation only: it holds no authority, sends nothing, and performs
 * no validation beyond trimming — the SERVER validates and normalizes the
 * snapshot (src/server/orders/service.ts). The destination it collects becomes
 * an order-authoritative snapshot; a later edit to the customer's profile does
 * not change it (§13).
 *
 * Mobile-first: a multi-line address textarea that wraps Khmer safely, large
 * touch targets, visible focus, and no fixed-width clipping. Every label is an
 * i18next key (EN + KM) — no hard-coded user-facing string.
 */
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ShippingDestinationValue } from "@/lib/shipping-destination";

export interface ShippingDestinationFieldsProps {
  value: ShippingDestinationValue;
  onChange: (next: ShippingDestinationValue) => void;
  /** Prefix for the field ids so two instances on one screen never collide. */
  idPrefix: string;
  disabled?: boolean;
}

export function ShippingDestinationFields({
  value,
  onChange,
  idPrefix,
  disabled = false,
}: ShippingDestinationFieldsProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-ship-name`} className="text-label text-text-secondary">
          {t("shipping.name")}
        </label>
        <Input
          id={`${idPrefix}-ship-name`}
          value={value.name}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder={t("shipping.namePlaceholder")}
          className="mt-1 h-11"
        />
      </div>

      <div>
        <label htmlFor={`${idPrefix}-ship-phone`} className="text-label text-text-secondary">
          {t("shipping.phone")}
        </label>
        <Input
          id={`${idPrefix}-ship-phone`}
          value={value.phone}
          disabled={disabled}
          inputMode="tel"
          onChange={(e) => onChange({ ...value, phone: e.target.value })}
          placeholder={t("shipping.phonePlaceholder")}
          className="tnum mt-1 h-11"
        />
      </div>

      <div>
        <label htmlFor={`${idPrefix}-ship-address`} className="text-label text-text-secondary">
          {t("shipping.address")}
        </label>
        <Textarea
          id={`${idPrefix}-ship-address`}
          value={value.address}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, address: e.target.value })}
          placeholder={t("shipping.addressPlaceholder")}
          rows={3}
          className="mt-1"
        />
      </div>

      <p className="text-caption text-text-muted">{t("shipping.note")}</p>
    </div>
  );
}
