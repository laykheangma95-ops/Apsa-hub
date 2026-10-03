import { Children, useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { Printer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { collectTrapFocusables, resolveTrapFocus } from "@/design-system/focus-trap";

/**
 * A print overlay for physical labels (product 50×30 mm, parcel 100×150 mm).
 *
 * V1 printing is browser/system only — no printer SDK, no Bluetooth (§7, §28).
 *
 * ── THE PREVIEW IS NOT PRINTABLE ──────────────────────────────────────────────
 * The on-screen preview is for looking at only. Under print media it — and all
 * app chrome — is removed from layout, so a native browser print (Ctrl/Cmd+P,
 * the browser's Print menu) can never put a stale, unvalidated preview on
 * paper: with no print target it outputs nothing.
 *
 * Printing happens ONLY from a temporary print target (<LabelPrintTarget>, a
 * direct child of <body>) that exists from the moment the pre-print check
 * succeeds until that one print is over:
 *
 *   Print pressed → onBeforePrint (fresh authoritative read, permission and
 *   lifecycle revalidation, identity guard) → target generated from the
 *   VALIDATED pages → window.print() → target destroyed.
 *
 * Ctrl/Cmd+P is routed into that same guarded path. A print the sheet did not
 * start (browser menu) finds no target: with none it prints nothing, and any
 * leftover is destroyed before the browser lays the page out. The target is
 * destroyed when its print ends (afterprint); where the browser's print UI
 * outlives window.print(), when the merchant is back on the page, bounded by
 * a time limit. It also goes when the sheet closes or stops being printable.
 *
 * In print, each label is its own physical page at the exact millimetre size,
 * so the barcode/QR are not clipped or rescaled (§27).
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
   * Runs immediately before printing and resolves to the VALIDATED pages to
   * print — built from fresh server data after authorization — or null to
   * refuse. Only those pages reach the printer; the preview never does. A
   * rejection, null or an empty list is a refusal. Without this hook (labels
   * with no server-side state, e.g. product labels) the current pages print.
   */
  onBeforePrint?: () => Promise<React.ReactNode[] | null>;
  /**
   * False while a child modal owns focus: this overlay's Tab/Escape trap stands
   * down so only ONE trap is live. Defaults to true.
   */
  active?: boolean;
  /** Each child is rendered as its own physical page. */
  children: React.ReactNode;
}

/** The id of the temporary print target — the only printable element. */
const PRINT_ROOT_ID = "apsa-print-root";

/**
 * How long a target may wait for a print UI that outlives window.print()
 * (asynchronous print dialogs). Past this, it is destroyed unprinted.
 */
const PRINT_SESSION_MAX_MS = 5 * 60 * 1000;

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
  // The temporary print target's pages; null whenever nothing may print.
  const [printPages, setPrintPages] = useState<React.ReactNode[] | null>(null);
  // Where the one print a target was generated for stands:
  //   idle     — no print of ours is under way: nothing is printable;
  //   printing — inside our window.print() call;
  //   pending  — window.print() returned before the print finished (a browser
  //              whose print UI is asynchronous, e.g. mobile): the target
  //              stays until the merchant is back on the page.
  const phaseRef = useRef<"idle" | "printing" | "pending">("idle");
  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const childrenRef = useRef(children);
  childrenRef.current = children;

  /** Destroy the temporary print target and end the print it was made for. */
  const endPrintSession = useCallback((sync = false) => {
    phaseRef.current = "idle";
    if (sessionTimerRef.current !== null) clearTimeout(sessionTimerRef.current);
    sessionTimerRef.current = null;
    if (sync) flushSync(() => setPrintPages(null));
    else setPrintPages(null);
  }, []);

  /** The ONLY path to paper: validate, generate the target, print, destroy. */
  async function handlePrint() {
    if (checking) return;
    endPrintSession();
    let pages: React.ReactNode[] | null;
    if (!onBeforePrint) {
      pages = Children.toArray(childrenRef.current);
    } else {
      setChecking(true);
      try {
        pages = await onBeforePrint();
      } catch {
        pages = null;
      }
      setChecking(false);
    }
    // Fail closed: a refusal, nothing to print, or a sheet closed meanwhile.
    if (!pages || pages.length === 0 || !openRef.current) return;
    flushSync(() => setPrintPages(pages));
    phaseRef.current = "printing";
    window.print();
    // A synchronous print (desktop) already fired afterprint and destroyed the
    // target. Otherwise the browser's print UI is still up: keep the target
    // for it, bounded, until the merchant returns to the page.
    if (phaseRef.current === "printing") {
      phaseRef.current = "pending";
      sessionTimerRef.current = setTimeout(() => endPrintSession(), PRINT_SESSION_MAX_MS);
    }
  }
  const handlePrintRef = useRef(handlePrint);
  handlePrintRef.current = handlePrint;
  const canStartPrintRef = useRef(false);
  canStartPrintRef.current = open && printable && active;

  // The target never outlives the sheet being open and printable.
  useEffect(() => {
    if (!open || !printable) endPrintSession();
  }, [open, printable, endPrintSession]);
  useEffect(() => () => endPrintSession(), [endPrintSession]);

  // Every browser print goes through the guard, or prints nothing.
  useEffect(() => {
    if (!open) return;
    // A print this sheet did not start (the browser's own menu) never finds a
    // target: it is destroyed before the browser lays the page out.
    const onBeforeNativePrint = () => {
      if (phaseRef.current === "idle") endPrintSession(true);
    };
    // The print this sheet started is over: destroy its target. (While a print
    // UI is pending the browser may render again, e.g. on a settings change;
    // that session ends when the merchant is back on the page instead.)
    const onAfterPrint = () => {
      if (phaseRef.current !== "pending") endPrintSession(true);
    };
    const onReturnToPage = () => {
      if (phaseRef.current === "pending") endPrintSession();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onReturnToPage();
    };
    // Ctrl/Cmd+P: never the browser's print of this page — the guarded path.
    const onPrintShortcut = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "p") return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat && canStartPrintRef.current) void handlePrintRef.current();
    };
    window.addEventListener("beforeprint", onBeforeNativePrint);
    window.addEventListener("afterprint", onAfterPrint);
    window.addEventListener("keydown", onPrintShortcut, true);
    window.addEventListener("focus", onReturnToPage);
    window.addEventListener("pointerdown", onReturnToPage, true);
    window.addEventListener("keydown", onReturnToPage, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeprint", onBeforeNativePrint);
      window.removeEventListener("afterprint", onAfterPrint);
      window.removeEventListener("keydown", onPrintShortcut, true);
      window.removeEventListener("focus", onReturnToPage);
      window.removeEventListener("pointerdown", onReturnToPage, true);
      window.removeEventListener("keydown", onReturnToPage, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [open, endPrintSession]);

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
  // Under print media EVERYTHING in <body> except the temporary print target
  // is removed from layout (display:none) — the app, this overlay and its
  // preview included. The target is a direct child of <body>, so its pages
  // flow in normal document order and the printer gets exactly one page per
  // label. With no target, nothing prints. On screen the target is never shown.
  const printCss = `
#${PRINT_ROOT_ID} { display: none; }
@media print {
  @page { size: ${pageSize.width}mm ${pageSize.height}mm; margin: 0; }
  html, body {
    margin: 0 !important; padding: 0 !important; background: #fff !important;
    height: auto !important; min-height: 0 !important; overflow: visible !important;
  }
  body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }
  #${PRINT_ROOT_ID} { display: block !important; position: static !important; margin: 0 !important; }
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
           * Preview only — never the print target. Each page is bordered and
           * scaled from millimetres; under print media it is not laid out.
           */}
          <div data-testid="label-preview" className="flex flex-col items-center gap-4">
            {mapPages(children, pageSize, "apsa-label-preview-page")}
          </div>
        </div>
      </div>

      {printPages
        ? createPortal(<LabelPrintTarget pages={printPages} pageSize={pageSize} />, document.body)
        : null}
    </div>
  );
}

/**
 * The temporary print target: the validated pages, one physical page each.
 * Rendered as a direct child of <body> only between a successful pre-print
 * check and the end of that print; LabelSheet's print CSS makes it the only
 * thing a print can output.
 */
export function LabelPrintTarget({
  pages,
  pageSize,
}: {
  pages: React.ReactNode[];
  pageSize: { width: number; height: number };
}) {
  return (
    <div id={PRINT_ROOT_ID} aria-hidden="true">
      {mapPages(pages, pageSize, "apsa-label-page")}
    </div>
  );
}

/** Wrap each child in a physical-page container sized in millimetres. */
function mapPages(
  children: React.ReactNode,
  pageSize: { width: number; height: number },
  pageClass: "apsa-label-page" | "apsa-label-preview-page",
) {
  const array = Array.isArray(children) ? children : [children];
  return array.map((child, index) => (
    <div
      key={index}
      className={`${pageClass} bg-white text-black shadow-[0_1px_4px_rgba(0,0,0,0.15)] print:shadow-none`}
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
