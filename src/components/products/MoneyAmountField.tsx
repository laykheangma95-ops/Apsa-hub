import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Chip } from "@/design-system";
import { formatMoney } from "@/lib/money";
import { parseMinorUnits, MINOR_UNIT_DIGITS } from "@/lib/catalog";
import type { Currency } from "@/types";

const CURRENCIES: readonly Currency[] = ["USD", "KHR"];

interface MoneyAmountFieldProps {
  id: string;
  label: string;
  /** The typed text, kept as a string so a half-typed "12." is never rounded. */
  value: string;
  onChange: (next: string) => void;
  currency: Currency;
  onCurrencyChange: (next: Currency) => void;
  hint?: string | undefined;
  /** Shown instead of the inputs being silently dead — says why they are locked. */
  lockedNote?: string | undefined;
  disabled?: boolean;
  error?: string | null;
}

/**
 * One amount, in one explicit currency, stored as integer minor units.
 *
 * The field holds text, not a number: parsing happens once, on submit, through
 * parseMinorUnits, which converts with integer arithmetic. Nothing here ever
 * multiplies a float by 100.
 *
 * The currency is always shown and always chosen — never inferred — because
 * $12.50 and 12,500៛ are different amounts and the server stores the currency
 * beside every value.
 */
export function MoneyAmountField({
  id,
  label,
  value,
  onChange,
  currency,
  onCurrencyChange,
  hint,
  lockedNote,
  disabled = false,
  error,
}: MoneyAmountFieldProps) {
  const { t } = useTranslation();
  const parsed = parseMinorUnits(value, currency);
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-label text-text-secondary">
        {label}
      </Label>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          inputMode="decimal"
          className="text-financial h-12 min-w-0 flex-1"
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          placeholder={MINOR_UNIT_DIGITS[currency] === 0 ? "0" : "0.00"}
          onChange={(event) => onChange(event.target.value)}
        />
        <div
          role="group"
          aria-label={t("catalog.variant.currency")}
          className="flex shrink-0 gap-1.5"
        >
          {CURRENCIES.map((option) => (
            <Chip
              key={option}
              selected={currency === option}
              disabled={disabled}
              onClick={() => onCurrencyChange(option)}
            >
              {option}
            </Chip>
          ))}
        </div>
      </div>

      {/*
       * The stored value read back in the merchant's own terms. It confirms
       * what will actually be saved — the minor-unit integer — rather than the
       * raw keystrokes, so a typo in the decimal place is visible before save.
       */}
      {parsed !== null && !error ? (
        <span className="text-data tnum text-text-muted">
          {formatMoney({ amount: parsed, currency })}
        </span>
      ) : null}

      {hint && !error ? (
        <span id={hintId} className="text-caption text-text-secondary">
          {hint}
        </span>
      ) : null}

      {lockedNote ? <span className="text-caption text-text-secondary">{lockedNote}</span> : null}

      {error ? (
        <p id={errorId} className="text-caption text-status-danger-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
