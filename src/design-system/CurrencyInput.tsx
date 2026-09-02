import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatMoney, usd, usdToKhr } from "@/lib/money";

interface CurrencyInputProps {
  /** integer cents */
  value: number;
  onChange: (cents: number) => void;
  label?: string;
  id?: string;
  className?: string;
}

export function CurrencyInput({
  value,
  onChange,
  label,
  id = "currency-input",
  className,
}: CurrencyInputProps) {
  const { t } = useTranslation();

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id} className="text-label text-text-secondary">
        {label ?? t("money.amountUsd")}
      </Label>
      <div className="relative">
        <span className="text-financial pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-secondary">
          $
        </span>
        <Input
          id={id}
          inputMode="decimal"
          className="text-financial h-12 pl-7"
          value={(value / 100).toFixed(2)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value.replace(/[^0-9.]/g, ""));
            onChange(Number.isFinite(parsed) ? Math.round(parsed * 100) : 0);
          }}
        />
      </div>
      <span className="text-data text-text-muted">
        {t("money.approx", { value: formatMoney(usdToKhr(usd(value))) })}
      </span>
    </div>
  );
}
