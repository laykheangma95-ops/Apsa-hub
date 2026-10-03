import { CheckCircle2, ClipboardCheck, Clock, PackageOpen, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { returnStatusLabelKey, type ReturnStatus } from "@/lib/returns";

const STYLE: Record<ReturnStatus, { icon: LucideIcon; className: string }> = {
  requested: { icon: Clock, className: "bg-surface-secondary text-text-secondary" },
  received: { icon: PackageOpen, className: "bg-status-info-soft text-status-info-text" },
  inspected: { icon: ClipboardCheck, className: "bg-status-warning-soft text-status-warning-text" },
  completed: { icon: CheckCircle2, className: "bg-status-success-soft text-status-success-text" },
};

/** A return's status in words with an icon — never conveyed by color alone. */
export function ReturnStatusLabel({
  status,
  className,
}: {
  status: ReturnStatus;
  className?: string;
}) {
  const { t } = useTranslation();
  const { icon: Icon, className: tone } = STYLE[status];
  return (
    <span
      className={cn(
        "text-caption inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5",
        tone,
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span>{t(returnStatusLabelKey(status))}</span>
    </span>
  );
}
