import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { collectTrapFocusables, nextTrapFocus } from "@/design-system/focus-trap";
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
  const overlayRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();
  const titleId = useId();
  const descriptionId = useId();

  /*
   * The sheet's open/close work runs once per open, not once per render.
   *
   * Consumers routinely pass an inline `onOpenChange` (CreateProductSheet wraps
   * it to reset the form), so the callback is a new identity on every keystroke
   * in a controlled field. With it in the dependency array this effect tore
   * down and re-ran between characters: the teardown restored focus to the
   * trigger and the re-run stole it to the panel, so a merchant could not type
   * a product name, and `restoreRef` was overwritten with whatever the churn
   * had just focused. Latest-callback refs keep the effect keyed to `open`
   * alone while still calling through to the current props.
   */
  const onOpenChangeRef = useRef(onOpenChange);
  const reduceMotionRef = useRef(reduceMotion);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
    reduceMotionRef.current = reduceMotion;
  }, [onOpenChange, reduceMotion]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    restoreRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // The dialog container itself, not its first field: opening a sheet must
    // not pop the phone keyboard before the merchant has asked for it.
    panel.focus();

    let focusTimer: ReturnType<typeof setTimeout> | undefined;

    const onFocusIn = (event: FocusEvent) => {
      const field = event.target;
      if (!(field instanceof HTMLElement)) return;

      /*
       * Backstop for focus that arrives without a Tab we could intercept — the
       * browser's own chrome-to-page cycle (F6, or tabbing out of the address
       * bar) hands focus to the first focusable in the document, which the
       * keydown trap never sees. `aria-modal` is a promise to assistive tech;
       * keep it true by pulling focus back inside.
       *
       * Scoped to the whole overlay, not just the panel, so the scrim is left
       * alone. The one thing this cannot allow for is a consumer that portals
       * focusable content out of the sheet (a Radix Select or Popover inside a
       * BottomSheet); no sheet does that today, and one that needs to should
       * render its menu inline rather than defeat the trap.
       */
      if (!overlayRef.current?.contains(field)) {
        panel.focus();
        return;
      }

      /*
       * Keyboard-safe fields. A sheet is fixed to the viewport, so on iOS the
       * opening keyboard can cover the very input the merchant just tapped —
       * the discount field, the cash-received field, an invite form. When a
       * field takes focus, bring it back inside the sheet's own scroll pane
       * once the keyboard has had a beat to settle. The pane scrolls, not the
       * page, so the sheet itself never jumps.
       */
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName)) return;
      focusTimer = setTimeout(() => {
        field.scrollIntoView({
          block: "center",
          behavior: reduceMotionRef.current ? "auto" : "smooth",
        });
      }, 300);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChangeRef.current(false);
        return;
      }
      if (event.key !== "Tab") return;

      /*
       * Recomputed per keystroke, never cached: a sheet's tab stops change as
       * the merchant types (a validation error appears, the save button
       * enables, a category list loads).
       */
      const focusables = collectTrapFocusables(panel);
      const next = nextTrapFocus(
        focusables,
        document.activeElement as HTMLElement | null,
        event.shiftKey,
      );

      /*
       * Tab is always ours while the sheet is open. Handing any case back to
       * the browser is what let focus walk out through the scrim and onto the
       * page behind; a sheet with no tab stops at all swallows the key and
       * keeps focus on the container.
       */
      event.preventDefault();
      (next ?? panel).focus();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      if (focusTimer) clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open ? (
        // z-[60]: above BottomNav's mobile bar (z-50), regardless of which one
        // mounts later in a given route's JSX — an open sheet must always sit
        // over the persistent nav, never under it.
        <div ref={overlayRef} className="fixed inset-0 z-[60] flex items-end justify-center">
          {/*
            Pointer-only close affordance. It sits outside the dialog panel, so
            leaving it in the tab order both broke containment (it was the stop
            Shift+Tab escaped through) and put a keyboard focus ring on an
            invisible full-viewport element. Escape and the sheet's own actions
            are the keyboard paths out.
          */}
          <motion.button
            type="button"
            tabIndex={-1}
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
            animate={{ y: "0%" }}
            exit={{ y: "100%" }}
            /*
             * A spring, not a tween: the sheet answers a thumb, so it should
             * arrive the way iOS sheets do — quick, settled, no overshoot
             * bounce. Damping 40 keeps it firm; it lands in roughly the same
             * ~260ms the old tween took, so no merchant action is delayed.
             */
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 380, damping: 40, mass: 0.9 }
            }
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
