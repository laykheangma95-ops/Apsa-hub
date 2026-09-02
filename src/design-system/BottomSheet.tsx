import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export type SheetSnap = "peek" | "half" | "full";

const SNAP_HEIGHT: Record<SheetSnap, string> = {
  peek: "32vh",
  half: "62vh",
  full: "92vh",
};

interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string | undefined;
  snap?: SheetSnap;
  children: ReactNode;
  className?: string;
}

export function BottomSheet({
  open,
  onOpenChange,
  title,
  snap = "half",
  children,
  className,
}: BottomSheetProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

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
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
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
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 90) onOpenChange(false);
            }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
            style={{ maxHeight: SNAP_HEIGHT[snap] }}
            className={cn(
              "relative flex w-full max-w-[560px] flex-col rounded-t-3xl bg-surface-elevated pb-[env(safe-area-inset-bottom)] outline-none",
              className,
            )}
          >
            <div className="flex justify-center pt-3 pb-1">
              <span className="h-1.5 w-10 rounded-full bg-border-strong" aria-hidden />
            </div>
            {title ? (
              <h2 className="text-h3 px-5 pt-1 pb-3 text-text-primary">{title}</h2>
            ) : null}
            <div className="flex-1 overflow-y-auto px-5 pb-5">{children}</div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
