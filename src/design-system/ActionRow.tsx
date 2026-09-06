import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface ActionRowProps {
  icon: LucideIcon;
  label: string;
  /** One line of "what this does". Omit when the label is self-evident. */
  description?: string | undefined;
  onClick?: () => void;
  disabled?: boolean;
  /** Marks the one action the merchant most likely came for. At most one. */
  emphasis?: boolean;
  /** Replaces the chevron — a value, a count, a status chip. */
  trailing?: React.ReactNode;
  className?: string;
}

/**
 * A tappable row inside a sheet or a settings list.
 *
 * One shape for every "pick an action" surface in APSA, so a merchant learns
 * the target size and the chevron's meaning once. The whole row is the target,
 * never just the label.
 */
export function ActionRow({
  icon: Icon,
  label,
  description,
  onClick,
  disabled = false,
  emphasis = false,
  trailing,
  className,
}: ActionRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      className={cn(
        "press flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        disabled
          ? "cursor-not-allowed border-border-default bg-surface-secondary/70 text-text-muted"
          : emphasis
            ? "border-action-primary-border bg-action-primary-soft text-text-primary"
            : "border-border-default bg-surface-primary text-text-primary active:bg-surface-secondary",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-2xl",
          disabled
            ? "bg-surface-primary text-text-muted"
            : emphasis
              ? "bg-action-primary text-text-on-action"
              : "bg-action-primary-soft text-action-primary",
        )}
      >
        <Icon className="size-[18px]" aria-hidden />
      </span>

      <span className="min-w-0 flex-1">
        <span className={cn("text-body block", emphasis && "font-semibold")}>{label}</span>
        {description ? (
          <span className="text-body-sm mt-0.5 block text-text-secondary">{description}</span>
        ) : null}
      </span>

      {trailing ?? (
        <ChevronRight
          className={cn("size-4 shrink-0", disabled ? "opacity-0" : "text-text-muted")}
          aria-hidden
        />
      )}
    </button>
  );
}
