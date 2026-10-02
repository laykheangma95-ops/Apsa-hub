import { useEffect, useRef, useState } from "react";
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
 *
 * ── ONE TRAP AT A TIME ────────────────────────────────────────────────────────
 * The design-system BottomSheet registers its own document-level Escape/focus
 * handling. If a child sheet (e.g. "Confirm shipping address") opens while this
 * overlay's window-level Tab/Escape trap is still live, the two compete: focus
 * ping-pongs and one Escape closes both. `active={false}` makes this overlay
 * stand down — presentation only, nothing is unmounted or reset — while a child
 * modal is up, leaving exactly one live trap; on becoming active again, focus
 * returns inside this dialog if the child's teardown left it outside.
 */
export interface LabelSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Physical page size in millimetres. */
  pageSize: { width: number; height: number };
  /** Non-printing controls (quantity, toggles) shown above the preview. */
  controls?: React.ReactNode;
  /**
   * Whether the current content may be printed. Defaults to true. When false
   * the header Print button is hidden — used to block printing a parcel label
   * whose destination is not yet confirmed (§9), so nothing unsafe is sent to a
   * printer.
   */
  printable?: boolean;
  /**
   * Runs immediately before window.print(); printing proceeds only if it
   * resolves true. Used for a fresh server-side authorization so a stale
   * client view alone can never print sensitive data. A rejection is a refusal.
   */
  onBeforePrint?: () => Promise<boolean>;
  /**
   * False while a child modal owns focus: this overlay's Tab/Escape trap stands
   * down so only ONE trap is live. Defaults to true.
   */
  active?: boolean;
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
  printable = true,
  active = true,
  onBeforePrint,
  children,
}: LabelSheetProps) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Latest onClose without re-running the effect between renders.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [checking, setChecking] = useState(false);

  async function handlePrint() {
    if (checking) return;
    if (!onBeforePrint) {
      window.print();
      return;
    }
    setChecking(true);
    let allowed = false;
    try {
      allowed = await onBeforePrint();
    } catch {
      allowed = false;
    }
    setChecking(false);
    if (allowed) window.print();
  }

  // Focus in on open, back to the invoking control on close (§21). Keyed to
  // `open` only — a child modal standing this overlay down must not restore
  // focus to the page behind it.
  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      restore?.focus?.();
    };
  }, [open]);

  // The Tab/Escape trap — live only while this overlay is the active modal.
  useEffect(() => {
    if (!open || !active) return;
    const panel = panelRef.current;
    // Returning from a child modal: if its teardown left focus outside this
    // dialog (e.g. its trigger was unmounted by a refetch), bring it back in.
    if (panel && !panel.contains(document.activeElement)) closeRef.current?.focus();

    // A key event that began BEFORE this trap was armed belongs to whichever
    // modal was active then. Without this, the Escape that closes a child sheet
    // re-arms this overlay mid-dispatch (React flushes the effect synchronously
    // for a discrete event) and the same keystroke reaches this window listener
    // too — closing the label dialog along with the child.
    const armedAt = performance.now();

    const onKey = (e: KeyboardEvent) => {
      if (e.timeStamp < armedAt) return;
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
    return () => window.removeEventListener("keydown", onKey);
  }, [open, active]);

  if (!open) return null;

  // Scoped print CSS; @page fixes the physical size and removes printer margins.
  //
  // Everything that is not #apsa-print-root, inside it, or one of its ancestors
  // is REMOVED from layout (display:none, not just hidden), and the ancestors —
  // including this fixed overlay and any h-screen/overflow app shell — become
  // plain static blocks. The pages then flow in normal document order, so the
  // printer gets exactly one 100×150 mm page per label. (A fixed overlay is
  // repeated on every printed page and never fragments, which printed labels
  // overlapping and duplicated, with a page count set by the app behind it.)
  const printCss = `
@media print {
  @page { size: ${pageSize.width}mm ${pageSize.height}mm; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body *:not(#apsa-print-root):not(#apsa-print-root *):not(:has(#apsa-print-root)) {
    display: none !important;
  }
  body *:has(#apsa-print-root) {
    display: block !important; position: static !important; inset: auto !important;
    width: auto !important; height: auto !important; min-height: 0 !important;
    max-height: none !important; overflow: visible !important; margin: 0 !important;
    padding: 0 !important; border: 0 !important; transform: none !important;
    background: #fff !important; box-shadow: none !important;
  }
  #apsa-print-root { display: block !important; position: static !important; margin: 0 !important; }
  .apsa-label-page { break-after: page; page-break-after: always; break-inside: avoid; }
  .apsa-label-page:last-child { break-after: auto; page-break-after: auto; }
}`;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal={active ? "true" : undefined}
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
        {printable ? (
          <Button
            type="button"
            onClick={() => void handlePrint()}
            disabled={checking}
            className="press-tactile tap-target h-10 gap-2 rounded-full px-4"
          >
            <Printer className="size-4" aria-hidden />
            {t("labels.print")}
          </Button>
        ) : null}
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
