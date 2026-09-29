/**
 * Keyboard-wedge scanner decision — behavioural unit tests (§9).
 *
 * Drives the pure scan machine the hook uses (barcode-scan-machine.ts), feeding
 * keystroke sequences with explicit timing and focus, and asserts the actual
 * outcome: a fast burst ending in Enter is ONE scan; ordinary typing (fast or
 * slow) in a focused field is NEVER a scan and never hijacks Enter; the Enter
 * terminator fires once; short bursts are ignored.
 *
 * Run: bun test src/tests/barcode-scanner.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  initialScanState,
  stepScan,
  type ScanConfig,
  type ScanKey,
  type ScanState,
} from "../hooks/barcode-scan-machine";

const CONFIG: ScanConfig = { minLength: 4, maxIntervalMs: 60 };

interface Keystroke extends ScanKey {
  /** ms since the previous key (drives burst timing). */
  after?: number;
}

/** Feed a sequence, returning every completed scan and each preventDefault flag. */
function run(keys: Keystroke[], config: ScanConfig = CONFIG) {
  let state: ScanState = initialScanState();
  let now = 1000;
  const scans: string[] = [];
  const prevented: boolean[] = [];
  for (const k of keys) {
    now += k.after ?? 5; // default: fast (scanner speed)
    const step = stepScan(state, k, now, config);
    state = step.state;
    if (step.scan !== null) scans.push(step.scan);
    if (step.preventDefault) prevented.push(true);
  }
  return { scans, prevented };
}

function chars(text: string, after: number, extra: Partial<ScanKey> = {}): Keystroke[] {
  return [...text].map((ch) => ({ key: ch, after, ...extra }));
}

describe("scan machine", () => {
  it("a fast burst ending in Enter is exactly one scan", () => {
    const { scans, prevented } = run([...chars("APSA1234", 5), { key: "Enter", after: 5 }]);
    expect(scans).toEqual(["APSA1234"]);
    expect(prevented).toEqual([true]); // the terminating Enter is consumed once
  });

  it("fast ordinary typing in a focused field is NOT a scan and never hijacks Enter", () => {
    const { scans, prevented } = run([
      ...chars("hello", 5, { editableFocus: true }),
      { key: "Enter", after: 5, editableFocus: true },
    ]);
    expect(scans).toEqual([]);
    expect(prevented).toEqual([]); // the field's own Enter submits normally
  });

  it("even a fast burst is ignored while a normal field is focused (wedge does not leak)", () => {
    const { scans } = run([
      ...chars("APSA9999", 3, { editableFocus: true }),
      { key: "Enter", after: 3, editableFocus: true },
    ]);
    expect(scans).toEqual([]);
  });

  it("slow human typing (long gaps) never accumulates a scan", () => {
    const { scans } = run([
      ...chars("APSA", 400), // 400ms between keys — human speed
      { key: "Enter", after: 400 },
    ]);
    expect(scans).toEqual([]);
  });

  it("the Enter terminator processes the scan once, not per repeat", () => {
    const { scans, prevented } = run([
      ...chars("PROD01", 5),
      { key: "Enter", after: 5 },
      { key: "Enter", after: 5 }, // a stray second Enter has an empty buffer
    ]);
    expect(scans).toEqual(["PROD01"]);
    expect(prevented).toEqual([true]);
  });

  it("two separate scans each fire once", () => {
    const { scans } = run([
      ...chars("AAA111", 5),
      { key: "Enter", after: 5 },
      ...chars("BBB222", 5),
      { key: "Enter", after: 5 },
    ]);
    expect(scans).toEqual(["AAA111", "BBB222"]);
  });

  it("a burst shorter than minLength is not a scan", () => {
    const { scans, prevented } = run([...chars("AB", 5), { key: "Enter", after: 5 }]);
    expect(scans).toEqual([]);
    expect(prevented).toEqual([]); // short Enter is left to submit normally
  });

  it("a modifier chord is ignored (state untouched)", () => {
    const { scans } = run([
      { key: "a", ctrlKey: true, after: 5 },
      { key: "c", ctrlKey: true, after: 5 },
    ]);
    expect(scans).toEqual([]);
  });

  it("a slow gap mid-way restarts the burst rather than joining two half-scans", () => {
    const { scans } = run([
      ...chars("AA", 5),
      ...chars("BB22", 5, { after: undefined }), // continue fast
      // Insert a slow key to break the burst:
    ]);
    // The above stays one fast burst (no Enter) → no scan yet; assert nothing fired.
    expect(scans).toEqual([]);

    const broken = run([
      ...chars("AA", 5),
      { key: "X", after: 500 }, // long gap resets buffer to "X"
      ...chars("99", 5),
      { key: "Enter", after: 5 },
    ]);
    // Only "X99" survived the reset — 3 chars < minLength 4 → not a scan.
    expect(broken.scans).toEqual([]);
  });
});
