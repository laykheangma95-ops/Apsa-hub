/*
 * The keyboard-wedge scanner's decision logic, as a pure state machine.
 *
 * Split out of use-barcode-scanner.ts on purpose — the same discipline as
 * design-system/focus-trap.ts. Whether a keystroke belongs to a scan burst, an
 * ordinary keypress, or a focused editable field is exactly the kind of thing
 * that must be proven rather than eyeballed, and the repo's test runner has no
 * DOM. So this function reads only plain values (no KeyboardEvent, no globals),
 * and the hook is a thin adapter that feeds it the real event + focus state.
 */

/** A keystroke reduced to just what the scan decision needs. */
export interface ScanKey {
  key: string;
  /** Any modifier held — a scanner sends plain characters, so a chord is never a scan. */
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /**
   * True when focus is inside an ordinary editable field (input/textarea/select/
   * contenteditable) that is NOT a dedicated scan input. Such keystrokes are the
   * user typing (or a wedge typing straight into that field) and must never be
   * interpreted as ambient scanning.
   */
  editableFocus?: boolean;
}

export interface ScanConfig {
  /** Shortest buffer treated as a scan. */
  minLength: number;
  /** Max ms between keystrokes to still count as one scan burst. */
  maxIntervalMs: number;
}

export interface ScanState {
  buffer: string;
  lastTime: number;
}

export interface ScanStep {
  state: ScanState;
  /** A completed scan payload, or null when this key did not complete one. */
  scan: string | null;
  /** Whether the caller should preventDefault (only the Enter that ended a scan). */
  preventDefault: boolean;
}

export function initialScanState(): ScanState {
  return { buffer: "", lastTime: 0 };
}

/**
 * Advance the machine by one keystroke.
 *
 * Rules, in order:
 *   - a modifier chord is ignored entirely (state unchanged);
 *   - focus in an ordinary editable field stands the scanner down: the buffer
 *     is cleared and nothing is interpreted, so typing/search/quantity entry are
 *     never captured and the Enter that submits a form is never hijacked (§9);
 *   - a gap longer than maxIntervalMs starts a fresh burst (human typing speed);
 *   - Enter completes a scan iff the buffer reached minLength — and only then is
 *     preventDefault requested, so an ordinary Enter still submits;
 *   - any single printable character extends the buffer.
 */
export function stepScan(
  state: ScanState,
  key: ScanKey,
  now: number,
  config: ScanConfig,
): ScanStep {
  if (key.ctrlKey || key.metaKey || key.altKey) {
    return { state, scan: null, preventDefault: false };
  }

  if (key.editableFocus) {
    // Stand down: never pollute the field, never interpret its keys.
    return { state: { buffer: "", lastTime: state.lastTime }, scan: null, preventDefault: false };
  }

  const gap = now - state.lastTime;
  const buffer = gap > config.maxIntervalMs ? "" : state.buffer;

  if (key.key === "Enter") {
    if (buffer.length >= config.minLength) {
      return { state: { buffer: "", lastTime: now }, scan: buffer, preventDefault: true };
    }
    return { state: { buffer: "", lastTime: now }, scan: null, preventDefault: false };
  }

  if (key.key.length === 1) {
    return {
      state: { buffer: buffer + key.key, lastTime: now },
      scan: null,
      preventDefault: false,
    };
  }

  // A non-printable, non-Enter key (Shift, Arrow…) does not extend the buffer
  // but still counts as recent activity for burst timing.
  return { state: { buffer, lastTime: now }, scan: null, preventDefault: false };
}
