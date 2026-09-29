import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Printer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { collectTrapFocusables, resolveTrapFocus } from "@/design-system/focus-trap";

/**
 * A print overlay for physical labels (product 50×30 mm, parcel 100×150 mm).
 *
 * V1 printing is browser/system only — no printer SDK, no Bluetooth (§7, §28).
 * The overlay shows an on-screen preview that IS the print target: on print, a
 * scoped @media-print stylesheet hides all app chrome and lays each label out as
 * its own physical page at the exact millimetre size, so the barcode/QR are not
 * clipped or rescaled (§27).
 *
 * ── FOCUS (§21) ───────────────────────────────────────────────────────────────
 * A real modal: aria-modal is truthful because focus is actually contained. On
 * open, the invoking control is remembered and focus moves into the dialog; Tab
 * and Shift+Tab cycle within it (reusing the same collectTrapFocusables /
 * resolveTrapFocus utility the design-system BottomSheet uses, so there is one
 * proven trap, not a second hand-rolled one); Escape closes; and on close focus
 * returns to the control that opened it.
 */
export interface LabelSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Physical page size in millimetres. */
  pageSize: { width: number; height: number };
  /** Non-printing controls (quantity, toggles) shown above the preview. */
  controls?: React.ReactNode;
  /** Each child is rendered as its own physical page. */
  children: React.ReactNode;
}

const MM_PER_PX = 96 / 25.4; // on-screen preview scale (CSS px per mm at 96dpi)

export function LabelSheet({
  open,
  onClose,
  title,
  pageSize,
  controls,
  children,
}: LabelSheetProps) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Latest onClose without re-running the effect between renders.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    // Remember the control that opened the dialog, to restore focus on close.
    const restore = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      // Tab is ours while the dialog is open — contain focus rather than let it
      // walk out onto the app behind the overlay (keeps aria-modal honest).
      e.preventDefault();
      const focusables = collectTrapFocusables(panel);
      const landed = resolveTrapFocus(
        focusables,
        document.activeElement as HTMLElement | null,
        e.shiftKey,
        (candidate) => {
          candidate.focus();
          return document.activeElement === candidate;
        },
      );
      if (!landed) panel.focus();
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Return focus to the invoking control (§21).
      restore?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  // Scoped print CSS. Only #apsa-print-root and its descendants stay visible;
  // @page fixes the physical size and removes printer margins.
  const printCss = `
@media print {
  @page { size: ${pageSize.width}mm ${pageSize.height}mm; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body * { visibility: hidden !important; }
  #apsa-print-root, #apsa-print-root * { visibility: visible !important; }
  #apsa-print-root { position: absolute; left: 0; top: 0; }
  .apsa-label-page { break-after: page; page-break-after: always; }
  .apsa-label-page:last-child { break-after: auto; page-break-after: auto; }
}`;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex flex-col bg-surface-secondary"
    >
      <style>{printCss}</style>

      <header className="flex items-center gap-2 border-b border-border-default bg-surface-primary px-4 py-3">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="press tap-target flex size-10 items-center justify-center rounded-full text-text-secondary"
        >
          <X className="size-5" aria-hidden />
        </button>
        <h2 className="text-h3 min-w-0 flex-1 truncate text-text-primary">{title}</h2>
        <Button
          type="button"
          onClick={() => window.print()}
          className="press-tactile tap-target h-10 gap-2 rounded-full px-4"
        >
          <Printer className="size-4" aria-hidden />
          {t("labels.print")}
        </Button>
      </header>

      {controls ? (
        <div className="border-b border-border-default bg-surface-primary px-4 py-3 print:hidden">
          {controls}
        </div>
      ) : null}

      <div className="flex-1 overflow-auto p-4">
        <div className="mx-auto flex w-fit flex-col items-center gap-4">
          {/*
           * The preview and the print target are the same DOM. On screen each
           * page is bordered and scaled from millimetres; in print the scoped CSS
           * above takes over and the border/shadow disappear with the chrome.
           */}
          <div id="apsa-print-root" className="flex flex-col items-center gap-4">
            {mapPages(children, pageSize)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Wrap each child in a physical-page container sized in millimetres. */
function mapPages(children: React.ReactNode, pageSize: { width: number; height: number }) {
  const array = Array.isArray(children) ? children : [children];
  return array.map((child, index) => (
    <div
      key={index}
      className="apsa-label-page bg-white text-black shadow-[0_1px_4px_rgba(0,0,0,0.15)] print:shadow-none"
      style={{
        width: `${pageSize.width}mm`,
        height: `${pageSize.height}mm`,
        // On-screen fidelity: the same box the printer will use.
        minWidth: `${pageSize.width * MM_PER_PX}px`,
        overflow: "hidden",
      }}
    >
      {child}
    </div>
  ));
}
