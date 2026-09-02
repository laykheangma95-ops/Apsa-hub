import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { formatMoney, usdToKhr } from "@/lib/money";
import type { Money as MoneyValue } from "@/types";

interface MoneyProps {
  value: MoneyValue;
  showSecondary?: boolean;
  size?: "lg" | "md" | "sm";
  className?: string;
}

export function Money({ value, showSecondary = false, size = "md", className }: MoneyProps) {
  const { t } = useTranslation();
  const sizeClass =
    size === "lg" ? "text-financial-lg" : size === "sm" ? "text-data" : "text-financial";

  return (
    <span className={cn("inline-flex flex-col", className)}>
      <span className={sizeClass}>{formatMoney(value)}</span>
      {showSecondary && value.currency === "USD" ? (
        <span className="text-data text-text-muted">
          {t("money.approx", { value: formatMoney(usdToKhr(value)) })}
        </span>
      ) : null}
    </span>
  );
}
