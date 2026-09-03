import { ChevronRight, Crown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StatusChip } from "@/design-system";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Staff } from "@/types";

interface StaffRowProps {
  member: Staff;
  onOpen: (member: Staff) => void;
}

export function StaffRow({ member, onOpen }: StaffRowProps) {
  const { t } = useTranslation();
  const isOwner = member.role === "owner";

  return (
    <button
      type="button"
      onClick={() => onOpen(member)}
      className={cn(
        "flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
        isOwner
          ? "border-action-primary/40 bg-action-primary-soft"
          : "border-border-default bg-surface-primary",
      )}
    >
      <span
        aria-hidden
        className="text-label grid size-11 shrink-0 place-items-center rounded-full bg-surface-secondary text-text-secondary"
      >
        {initials(member.name)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="text-label flex min-w-0 items-center gap-1.5 text-text-primary">
          {isOwner ? <Crown className="size-4 shrink-0 text-action-primary" aria-hidden /> : null}
          <span className="min-w-0 break-words">{member.name}</span>
        </span>
        <span className="text-caption block break-words text-text-secondary">
          {t(`team.role.${member.role}`)}
        </span>
      </span>

      <StatusChip status={member.status === "invited" ? "invited" : "active"} className="shrink-0" />
      <ChevronRight className="size-4 shrink-0 text-text-secondary" aria-hidden />
    </button>
  );
}
