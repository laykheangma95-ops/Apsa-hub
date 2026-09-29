/**
 * Pure Code 128 (Code Set B) barcode encoder + SVG renderer.
 *
 * V1 uses browser/system printing only — no printer SDK, no Bluetooth, no
 * proprietary driver (session scope §7/§28). A label is an ordinary SVG the
 * browser prints; this module turns a code string into that SVG.
 *
 * Deliberately dependency-free and pure: the same input always produces the
 * same module pattern, so the encoding is exhaustively testable without a
 * scanner in the loop. No DOM, no I/O, no randomness — safe to import from
 * either the client bundle or a server function.
 *
 * Code Set B covers all printable ASCII (32–126): uppercase letters, digits and
 * the punctuation an APSA code or a manufacturer barcode uses. Code C (denser,
 * digit-pairs) is intentionally not implemented in V1 — correctness over
 * density for a label a phone camera or a cheap USB scanner must read.
 */

/**
 * The 107 Code 128 symbol patterns (values 0–106), each a run-length string of
 * module widths that alternate bar/space starting with a bar. Values 103–105 are
 * the Start codes (A/B/C); 106 is Stop, which carries its own 2-module
 * termination bar (13 modules, hence 7 digits). This is the canonical table from
 * the Code 128 specification — never edit a single digit.
 */
const CODE128_PATTERNS: readonly string[] = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112",
];

const START_B = 104;
const STOP = 106;
const CODE_B_OFFSET = 32; // value = charCode - 32 for ASCII 32..126

/** Smallest / largest ASCII code Code Set B can represent. */
const MIN_ASCII = 32;
const MAX_ASCII = 126;

export interface Code128RenderOptions {
  /** Width of one module (narrowest bar) in px. Default 2. */
  moduleWidth?: number;
  /** Bar height in px. Default 60. */
  height?: number;
  /** Quiet-zone width in modules on each side. Default 10 (spec minimum). */
  quietModules?: number;
  /**
   * When true (the default), the SVG scales to the width of its container
   * instead of pinning a fixed pixel width. The intrinsic module/quiet-zone
   * geometry becomes the `viewBox`, and width/height are set to 100% with
   * `preserveAspectRatio="none"`, so a long barcode on a narrow 50×30 mm label
   * shrinks to fit rather than being clipped by the label's `overflow:hidden`.
   * The bar-to-bar proportions and the quiet zones are preserved because every
   * bar scales by the same factor. Set false for a fixed intrinsic-size SVG
   * (e.g. a width-assertion unit test).
   */
  responsive?: boolean;
}

/**
 * Encode a string into the ordered list of Code 128 symbol values, including the
 * Start B code, the checksum symbol and the Stop code.
 *
 * Throws on any character outside printable ASCII (32–126) rather than silently
 * dropping it — a barcode that omits a character is a barcode that scans to the
 * wrong product, which is worse than a loud failure at label time.
 */
export function encodeCode128B(value: string): number[] {
  if (value.length === 0) {
    throw new Error("Code 128: cannot encode an empty string");
  }

  const symbols: number[] = [START_B];
  let weightedSum = START_B; // checksum seed

  for (let i = 0; i < value.length; i += 1) {
    const charCode = value.charCodeAt(i);
    if (charCode < MIN_ASCII || charCode > MAX_ASCII) {
      throw new Error(
        `Code 128: character at index ${i} (code ${charCode}) is outside printable ASCII`,
      );
    }
    const symbolValue = charCode - CODE_B_OFFSET;
    symbols.push(symbolValue);
    // Position weight starts at 1 for the first DATA character.
    weightedSum += symbolValue * (i + 1);
  }

  const checksum = weightedSum % 103;
  symbols.push(checksum);
  symbols.push(STOP);
  return symbols;
}

/**
 * Whether every character of `value` is representable in Code Set B (printable
 * ASCII 32–126) and the string is non-empty — i.e. whether renderCode128Svg /
 * encodeCode128B can encode it WITHOUT throwing.
 *
 * Used to (a) validate a manual/manufacturer barcode before it is stored, so a
 * value that would crash label generation is never persisted, and (b) guard the
 * label view-model builder against any such value already in the data. Common
 * manufacturer formats (EAN/UPC digits, alphanumeric codes) all pass; only
 * non-ASCII or control characters fail.
 */
export function isCode128Encodable(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < MIN_ASCII || code > MAX_ASCII) return false;
  }
  return true;
}

/**
 * The full bar/space module sequence for a value, as booleans (true = bar).
 * Every symbol's pattern begins with a bar, so runs alternate deterministically.
 */
export function code128Modules(value: string): boolean[] {
  const symbols = encodeCode128B(value);
  const modules: boolean[] = [];
  for (const symbol of symbols) {
    const pattern = CODE128_PATTERNS[symbol];
    if (!pattern) throw new Error(`Code 128: no pattern for symbol ${symbol}`);
    let isBar = true;
    for (const digit of pattern) {
      const run = Number(digit);
      for (let n = 0; n < run; n += 1) modules.push(isBar);
      isBar = !isBar;
    }
  }
  return modules;
}

/** Total module count (excluding quiet zones) for a value. */
export function code128ModuleCount(value: string): number {
  return code128Modules(value).length;
}

/**
 * Render a value as a self-contained SVG string (no external fonts, no script).
 *
 * The SVG is a plain set of black rects on a transparent ground plus a white
 * quiet zone — it prints crisply at any physical size the print CSS sets, and
 * carries no APSA branding of its own (the label composes the branding around
 * it). `role="img"` + the label make it accessible; the human-readable number is
 * rendered by the label component, not baked in here.
 */
export function renderCode128Svg(value: string, options: Code128RenderOptions = {}): string {
  const moduleWidth = options.moduleWidth ?? 2;
  const height = options.height ?? 60;
  const quiet = options.quietModules ?? 10;
  const responsive = options.responsive ?? true;

  const modules = code128Modules(value);
  const totalModules = modules.length + quiet * 2;
  const width = totalModules * moduleWidth;

  const rects: string[] = [];
  // Coalesce consecutive bar modules into a single rect — fewer nodes, same output.
  let i = 0;
  while (i < modules.length) {
    if (!modules[i]) {
      i += 1;
      continue;
    }
    let run = 1;
    while (i + run < modules.length && modules[i + run]) run += 1;
    const rectX = (quiet + i) * moduleWidth;
    rects.push(
      `<rect x="${rectX}" y="0" width="${run * moduleWidth}" height="${height}" fill="#000"/>`,
    );
    i += run;
  }

  // Responsive: the intrinsic geometry lives entirely in the viewBox, and the
  // SVG fills its container (100% × 100%), so the label's CSS box controls the
  // physical size and a long code can never overflow/clip. The quiet zones are
  // part of the viewBox, so they scale with the bars. Non-responsive: pin the
  // intrinsic pixel size (used by width-assertion tests).
  const sizeAttrs = responsive
    ? `width="100%" height="100%"`
    : `width="${width}" height="${height}"`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ${sizeAttrs} ` +
    `viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges">` +
    rects.join("") +
    `</svg>`
  );
}
