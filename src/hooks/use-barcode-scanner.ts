import { useEffect, useRef } from "react";
import { initialScanState, stepScan, type ScanState } from "@/hooks/barcode-scan-machine";

/**
 * Listen for an ordinary USB / Bluetooth barcode scanner, which presents itself
 * as a keyboard: it "types" the barcode very fast and ends with Enter (§8).
 *
 * The scan decision itself is a pure state machine (barcode-scan-machine.ts,
 * unit-tested without a DOM). This hook is the thin adapter: it reads the real
 * KeyboardEvent and the current focus, feeds them to the machine, and applies
 * the machine's verdict (preventDefault + onScan).
 *
 * ── FOCUS ISOLATION (§9) ──────────────────────────────────────────────────────
 * A wedge scanner types into whatever has focus, so timing alone is not enough:
 * while focus is inside an ordinary input/textarea/select/contenteditable the
 * listener stands down entirely (the machine's editableFocus branch), so search,
 * quantity entry and form submits are never captured. A dedicated scan field can
 * opt back in with SCAN_INPUT_ATTRIBUTE. Ambient scanning (nothing editable
 * focused) works exactly as before.
 */
export interface UseBarcodeScannerOptions {
  enabled: boolean;
  onScan: (code: string) => void;
  /** Shortest buffer treated as a scan. Default 4. */
  minLength?: number;
  /** Max ms between keystrokes to still count as one scan burst. Default 60. */
  maxIntervalMs?: number;
}

/** Attribute a dedicated scan input sets so the global listener still serves it. */
export const SCAN_INPUT_ATTRIBUTE = "data-apsa-scan-input";

/**
 * Whether keystrokes to this element belong to the user editing a field (so the
 * scanner listener must NOT interpret them), rather than ambient scanning.
 * A dedicated scan input opts back in via the SCAN_INPUT_ATTRIBUTE.
 */
export function isEditableTarget(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.hasAttribute(SCAN_INPUT_ATTRIBUTE)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useBarcodeScanner({
  enabled,
  onScan,
  minLength = 4,
  maxIntervalMs = 60,
}: UseBarcodeScannerOptions): void {
  // Keep the latest callback without re-binding the listener each render.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const stateRef = useRef<ScanState>(initialScanState());

  useEffect(() => {
    if (!enabled) return;

    const handler = (event: KeyboardEvent) => {
      const step = stepScan(
        stateRef.current,
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          editableFocus: isEditableTarget(document.activeElement),
        },
        Date.now(),
        { minLength, maxIntervalMs },
      );
      stateRef.current = step.state;
      if (step.preventDefault) event.preventDefault();
      if (step.scan !== null) onScanRef.current(step.scan);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, minLength, maxIntervalMs]);
}
