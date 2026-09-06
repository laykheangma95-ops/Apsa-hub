import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export type SheetSnap = "peek" | "half" | "full";

/*
 * dvh, not vh. On iOS Safari `vh` is measured against the tallest possible
 * viewport, so a 92vh sheet ran under the browser chrome and buried its own
 * confirm button. dvh tracks the viewport the merchant can actually see.
 */
const SNAP_HEIGHT: Record<SheetSnap, string> = {
  peek: "42dvh",
  half: "68dvh",
  full: "92dvh",
};

interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string | undefined;
  /** One line under the title. Explains the choice, never repeats it. */
  description?: string | undefined;
  snap?: SheetSnap;
  /**
   * Sheet-level confirm. Pinned inside the sheet with safe-area padding so a
   * long form never hides the action that closes it.
   */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * The APSA sheet: the default way to ask for one more thing on a phone.
 *
 * Preferred over a full page for anything the merchant is doing *inside* the
 * current context — pick a variant, record a payment, choose a courier — so
 * the screen behind stays visible and back means back.
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  snap = "half",
  footer,
  children,
  className,
}: BottomSheetProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => !node.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, onOpenChange]);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <motion.button
            type="button"
            aria-label={t("common.close")}
            className="absolute inset-0 h-full w-full"
            style={{ backgroundColor: "var(--surface-scrim)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.2, 0, 0, 1] }}
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            {...(title ? { "aria-labelledby": titleId } : { "aria-label": t("common.close") })}
            {...(description ? { "aria-describedby": descriptionId } : {})}
            tabIndex={-1}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.35 }}
            dragDirectionLock
            onDragEnd={(_, info) => {
              // Velocity as well as distance: a quick flick dismisses without
              // dragging the sheet all the way down.
              if (info.offset.y > 90 || info.velocity.y > 700) onOpenChange(false);
            }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: reduceMotion ? 0 : 0.26, ease: [0.2, 0, 0, 1] }}
            style={{ maxHeight: SNAP_HEIGHT[snap] }}
            className={cn(
              "elevation-3 relative flex w-full max-w-[var(--screen-max)] flex-col rounded-t-[28px] bg-surface-elevated outline-none",
              className,
            )}
          >
            <div className="flex shrink-0 justify-center pt-2.5 pb-1">
              <span className="h-1 w-9 rounded-full bg-border-strong" aria-hidden />
            </div>

            {title ? (
              <div className="shrink-0 px-5 pt-1 pb-3">
                <h2 id={titleId} className="text-h2 text-text-primary">
                  {title}
                </h2>
                {description ? (
                  <p id={descriptionId} className="text-body-sm mt-1 text-text-secondary">
                    {description}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div
              className={cn(
                "scroll-pane min-h-0 flex-1 px-5",
                footer ? "pb-3" : "pb-[calc(env(safe-area-inset-bottom)+1.25rem)]",
              )}
            >
              {children}
            </div>

            {footer ? (
              <div className="shrink-0 border-t border-border-default px-5 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.875rem)]">
                {footer}
              </div>
            ) : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
