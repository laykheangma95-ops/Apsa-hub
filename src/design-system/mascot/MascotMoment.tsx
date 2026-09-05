import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Mascot } from "./Mascot";
import { COMPANION_TOKEN } from "./mascot-assets";
import { MASCOT_STATES, type MascotState } from "./mascot-states";

interface MascotMomentProps {
  state: MascotState;
  title: string;
  body?: string;
  action?: ReactNode;
  size?: number;
  /** Card layout for celebratory moments, inline for quiet ones. */
  variant?: "card" | "plain";
  className?: string;
}

/**
 * Standard block for a mascot moment: success sheets, achievement popups,
 * onboarding steps, empty states and insight cards all use this shape so the
 * character never appears in a one-off layout.
 */
export function MascotMoment({
  state,
  title,
  body,
  action,
  size = 96,
  variant = "plain",
  className,
}: MascotMomentProps) {
  const spec = MASCOT_STATES[state];
  const accent = spec.companion ? COMPANION_TOKEN[spec.companion] : "var(--action-primary)";

  return (
    <div
      className={cn(
        "flex flex-col items-center px-6 py-8 text-center",
        variant === "card" && "rounded-2xl border border-border-default bg-surface-primary",
        className,
      )}
      style={
        variant === "card"
          ? { boxShadow: `0 24px 48px -32px color-mix(in oklab, ${accent} 60%, transparent)` }
          : undefined
      }
    >
      <Mascot state={state} size={size} withCompanion />
      <h3 className="text-h3 mt-4 text-text-primary">{title}</h3>
      {body ? <p className="text-body mt-1 max-w-xs text-text-secondary">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
