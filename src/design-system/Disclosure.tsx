import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface DisclosureProps {
  /** Base for the trigger and panel ids, which wire aria-controls / aria-labelledby. */
  id: string;
  title: ReactNode;
  /** One short line under the title, readable while collapsed. */
  summary?: ReactNode;
  /** Trailing marker before the chevron (a count). Decorative unless it says otherwise. */
  badge?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

/**
 * A heading that opens and closes the section under it (WAI-ARIA accordion
 * pattern, single section).
 *
 * - The trigger is a native button inside the heading: Enter and Space work,
 *   focus is visible, and it carries aria-expanded / aria-controls.
 * - The panel is a labelled region. Closed, it is zero rows tall AND
 *   visibility:hidden (see .disclosure-panel), so its links leave the tab
 *   order and the accessibility tree rather than hiding behind a clip; `inert`
 *   says the same to browsers that support it.
 * - The height change animates with grid-template-rows and the shared motion
 *   tokens, which collapse to an instant cut under prefers-reduced-motion.
 *
 * Controlled, so the owner can react to the change (Home holds its tiles'
 * size while the list is open).
 */
export function Disclosure({
  id,
  title,
  summary,
  badge,
  open,
  onOpenChange,
  children,
  className,
}: DisclosureProps) {
  const triggerId = `${id}-trigger`;
  const panelId = `${id}-panel`;

  return (
    <section
      className={cn(
        "elevation-1 rounded-2xl border border-border-default bg-surface-primary",
        className,
      )}
    >
      <h2>
        <button
          type="button"
          id={triggerId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onOpenChange(!open)}
          className="press tap-target flex w-full items-center gap-3 rounded-2xl px-4 py-2.5 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="text-label block text-text-primary">{title}</span>
            {summary ? (
              <span className="text-caption mt-0.5 block text-text-secondary">{summary}</span>
            ) : null}
          </span>
          {badge}
          <ChevronDown className="disclosure-chevron size-5 shrink-0 text-text-muted" aria-hidden />
        </button>
      </h2>
      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        data-open={open ? "true" : "false"}
        inert={!open}
        className="disclosure-panel"
      >
        <div>{children}</div>
      </div>
    </section>
  );
}
