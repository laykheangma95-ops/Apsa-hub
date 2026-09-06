import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { StatusChip } from "./StatusChip";
import type { StatusKey } from "@/types";

interface StatusHeroProps {
  /** Quiet line above the headline: an order code, a tracking number, a date. */
  eyebrow?: ReactNode;
  /** The one thing to read first — a total, a courier, a customer's name. */
  headline: ReactNode;
  /** Small print under the headline. */
  support?: ReactNode;
  /**
   * The state of the thing. The first entry is the one the merchant is asked
   * about most; it renders larger than the rest so three statuses stop reading
   * as three equals.
   */
  primaryStatus?: StatusKey | undefined;
  secondaryStatuses?: readonly StatusKey[];
  /** What happens next, in business language. One sentence, never a control. */
  nextStep?: ReactNode;
  className?: string;
}

/**
 * The top of every detail screen.
 *
 * Order, delivery and customer detail all used to open with a flat stack of
 * equal cards, so nothing told the merchant where to look. One hero, one
 * dominant status, and everything else demoted — hierarchy is the whole job.
 */
export function StatusHero({
  eyebrow,
  headline,
  support,
  primaryStatus,
  secondaryStatuses = [],
  nextStep,
  className,
}: StatusHeroProps) {
  return (
    <section
      className={cn(
        "elevation-2 relative overflow-hidden rounded-[26px] border border-action-primary-border bg-[linear-gradient(168deg,rgba(255,255,255,0.98)_0%,rgba(234,242,254,0.92)_100%)] px-4 py-4",
        className,
      )}
    >
      {eyebrow ? <p className="text-caption tnum text-text-muted">{eyebrow}</p> : null}

      <div className="mt-0.5 min-w-0">{headline}</div>

      {support ? <div className="text-body-sm mt-1 text-text-secondary">{support}</div> : null}

      {primaryStatus || secondaryStatuses.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {primaryStatus ? <StatusChip status={primaryStatus} size="md" /> : null}
          {secondaryStatuses.map((status) => (
            <StatusChip key={status} status={status} size="sm" />
          ))}
        </div>
      ) : null}

      {nextStep ? (
        <p className="text-body-sm mt-3 border-t border-action-primary-border/70 pt-3 text-text-secondary">
          {nextStep}
        </p>
      ) : null}
    </section>
  );
}
