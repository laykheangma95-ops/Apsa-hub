import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { StaffRole } from "@/types";

export const INVITABLE_ROLES: StaffRole[] = ["manager", "cashier", "sales", "customer_service"];

interface RoleOptionProps {
  role: StaffRole;
  selected: boolean;
  onSelect: (role: StaffRole) => void;
}

export function RoleOption({ role, selected, onSelect }: RoleOptionProps) {
  const { t } = useTranslation();
  const descriptionId = `role-desc-${role}`;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-describedby={descriptionId}
      onClick={() => onSelect(role)}
      className={cn(
        "tap-target flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
        selected
          ? "border-action-primary bg-action-primary-soft"
          : "border-border-default bg-surface-primary",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="text-label block text-text-primary">{t(`team.role.${role}`)}</span>
        <span id={descriptionId} className="text-caption block text-text-secondary">
          {t(`team.roleDescription.${role}`)}
        </span>
      </span>
      {selected ? <Check className="mt-0.5 size-5 shrink-0 text-action-primary" aria-hidden /> : null}
    </button>
  );
}
