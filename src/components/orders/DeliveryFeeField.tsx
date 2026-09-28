import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DELIVERY_FEE_MAX_MINOR, parseDeliveryFee } from "@/lib/delivery-fee";
import { MINOR_UNIT_DIGITS, formatMoney } from "@/lib/money";
import type { Currency } from "@/types";

interface DeliveryFeeFieldProps {
  id: string;
  /** Kept as text so a half-typed "1." is never rounded; parsed on use. */
  value: string;
  onChange: (next: string) => void;
  /** The order's currency (= the catalog price currency). Not selectable. */
  currency: Currency;
}

/**
 * Delivery fee charged to the customer, in the order's own currency.
 *
 * Same pattern as RecordOrderPaymentSheet's amount: a text field parsed with
 * integer arithmetic, a fixed currency (offering a picker would be offering an
 * implicit conversion), and the parsed value read back so a decimal-place typo
 * is visible before submit. The server bounds and totals it independently.
 */
export function DeliveryFeeField({ id, value, onChange, currency }: DeliveryFeeFieldProps) {
  const { t } = useTranslation();
  const parsed = parseDeliveryFee(value, currency);
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-label text-text-secondary">
        {t("deliveryFee.label", { currency })}
      </Label>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        className="text-financial h-12"
        value={value}
        placeholder={MINOR_UNIT_DIGITS[currency] === 0 ? "0" : "0.00"}
        aria-invalid={parsed === null ? true : undefined}
        aria-describedby={parsed === null ? errorId : hintId}
        onChange={(event) => onChange(event.target.value)}
      />
      {parsed === null ? (
        <p id={errorId} role="alert" className="text-caption text-status-danger-text">
          {t("deliveryFee.invalid", {
            max: formatMoney({ amount: DELIVERY_FEE_MAX_MINOR[currency], currency }),
          })}
        </p>
      ) : (
        <span id={hintId} className="text-caption text-text-secondary">
          {t("deliveryFee.hint")}
        </span>
      )}
    </div>
  );
}
