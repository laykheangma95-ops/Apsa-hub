import { useEffect, useRef } from "react";

/**
 * Listen for an ordinary USB / Bluetooth barcode scanner, which presents itself
 * as a keyboard: it "types" the barcode very fast and ends with Enter (§8).
 *
 * The heuristic separates a scan from human typing by inter-key timing — a
 * scanner fires characters within a few milliseconds of each other, far faster
 * than a person. A rapid burst terminated by Enter, at least `minLength`
 * characters long, is treated as a scan and `onScan` fires. Slow human typing
 * (including pressing Enter in the search box) never accumulates a long enough
 * fast buffer, so it is left completely alone.
 *
 * No camera is involved (that is deferred — §9); this is purely keyboard-wedge
 * input and manual entry / search continue to work unchanged.
 */
export interface UseBarcodeScannerOptions {
  enabled: boolean;
  onScan: (code: string) => void;
  /** Shortest buffer treated as a scan. Default 4. */
  minLength?: number;
  /** Max ms between keystrokes to still count as one scan burst. Default 60. */
  maxIntervalMs?: number;
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

  const bufferRef = useRef("");
  const lastTimeRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const handler = (event: KeyboardEvent) => {
      // Ignore modified chords — a scanner sends plain characters.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const now = Date.now();
      const gap = now - lastTimeRef.current;
      lastTimeRef.current = now;

      if (gap > maxIntervalMs) {
        // Too slow to be part of a scan burst — start fresh.
        bufferRef.current = "";
      }

      if (event.key === "Enter") {
        const code = bufferRef.current;
        bufferRef.current = "";
        if (code.length >= minLength) {
          // It was a scan: consume the Enter so it does not submit a form.
          event.preventDefault();
          onScanRef.current(code);
        }
        return;
      }

      // Only single printable characters extend the buffer.
      if (event.key.length === 1) {
        bufferRef.current += event.key;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, minLength, maxIntervalMs]);
}
