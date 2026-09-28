/**
 * Pure, dependency-free QR Code encoder (byte mode) + SVG renderer.
 *
 * V1 renders an optional APSA QR on product labels and on parcel labels using
 * only the browser to print (no SDK). The payloads are tiny `apsa:` references
 * (see ./payload) with no PII or secret, so a low QR version with solid error
 * correction is plenty — this encoder supports versions 1–10 at EC level L or M,
 * which fits every APSA payload with room to spare.
 *
 * Deterministic and side-effect free: the same text + EC level always yields the
 * same module matrix, which is what makes it testable without a camera in the
 * loop. Implements the parts of ISO/IEC 18004 a short byte-mode payload needs:
 * Reed–Solomon over GF(256), block interleaving, the eight data masks with the
 * standard penalty scoring, and BCH format/version information.
 *
 * No DOM, no I/O, no randomness — safe to import from client or server.
 */

export type QrEcLevel = "L" | "M";

// ── GF(256) arithmetic (primitive polynomial 0x11d) ────────────────────────────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Reed–Solomon generator polynomial of the given degree. */
function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Error-correction codewords for one data block. */
function rsEncodeBlock(data: number[], ecCount: number): number[] {
  const gen = rsGeneratorPoly(ecCount);
  const remainder = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < gen.length - 1; i += 1) {
      remainder[i] ^= gfMul(gen[i + 1]!, factor);
    }
  }
  return remainder;
}

// ── Version / EC block structure (versions 1–10, levels L and M) ───────────────
//
// Each entry: [ecCodewordsPerBlock, [numBlocks, dataCodewordsPerBlock], (group2?)].
// Canonical values from ISO/IEC 18004 Annex — never edit without re-verifying.

type BlockSpec = [number, [number, number], [number, number]?];

const EC_BLOCKS: Record<QrEcLevel, Record<number, BlockSpec>> = {
  L: {
    1: [7, [1, 19]],
    2: [10, [1, 34]],
    3: [15, [1, 55]],
    4: [20, [1, 80]],
    5: [26, [1, 108]],
    6: [18, [2, 68]],
    7: [20, [2, 78]],
    8: [24, [2, 97]],
    9: [30, [2, 116]],
    10: [18, [2, 68], [2, 69]],
  },
  M: {
    1: [10, [1, 16]],
    2: [16, [1, 28]],
    3: [26, [1, 44]],
    4: [18, [2, 32]],
    5: [24, [2, 43]],
    6: [16, [4, 27]],
    7: [18, [4, 31]],
    8: [22, [2, 38], [2, 39]],
    9: [22, [3, 36], [2, 37]],
    10: [26, [4, 43], [1, 44]],
  },
};

const MAX_VERSION = 10;

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT_CENTERS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

function totalDataCodewords(version: number, ec: QrEcLevel): number {
  const spec = EC_BLOCKS[ec][version]!;
  const [, g1, g2] = spec;
  let total = g1[0] * g1[1];
  if (g2) total += g2[0] * g2[1];
  return total;
}

// ── Bit buffer ─────────────────────────────────────────────────────────────────

class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }
  get length(): number {
    return this.bits.length;
  }
}

const BYTE_MODE_INDICATOR = 0b0100;

function charCountBits(version: number): number {
  // Byte mode: 8 bits for versions 1–9, 16 bits for 10–40.
  return version <= 9 ? 8 : 16;
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Choose the smallest supported version that fits, then build interleaved codewords. */
function buildCodewords(text: string, ec: QrEcLevel): { version: number; codewords: number[] } {
  const data = utf8Bytes(text);

  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const capacityBits = totalDataCodewords(v, ec) * 8;
    const needed = 4 + charCountBits(v) + data.length * 8;
    if (needed <= capacityBits) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    throw new Error(
      `QR: payload too long for supported versions 1–${MAX_VERSION} at EC level ${ec}`,
    );
  }

  const buffer = new BitBuffer();
  buffer.put(BYTE_MODE_INDICATOR, 4);
  buffer.put(data.length, charCountBits(version));
  for (const byte of data) buffer.put(byte, 8);

  const totalData = totalDataCodewords(version, ec);
  const capacityBits = totalData * 8;

  // Terminator (up to 4 zero bits), then pad to a byte boundary.
  const terminator = Math.min(4, capacityBits - buffer.length);
  buffer.put(0, terminator);
  while (buffer.length % 8 !== 0) buffer.bits.push(0);

  // Data codewords, then the alternating pad codewords 0xEC / 0x11.
  const dataCodewords: number[] = [];
  for (let i = 0; i < buffer.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | buffer.bits[i + j]!;
    dataCodewords.push(byte);
  }
  const PAD = [0xec, 0x11];
  let padIndex = 0;
  while (dataCodewords.length < totalData) {
    dataCodewords.push(PAD[padIndex % 2]!);
    padIndex += 1;
  }

  return { version, codewords: interleave(dataCodewords, version, ec) };
}

/** Split into blocks, RS-encode each, then interleave data and EC codewords per spec. */
function interleave(dataCodewords: number[], version: number, ec: QrEcLevel): number[] {
  const spec = EC_BLOCKS[ec][version]!;
  const ecCount = spec[0];
  const groups: Array<[number, number]> = [spec[1]];
  if (spec[2]) groups.push(spec[2]);

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const [numBlocks, dataPerBlock] of groups) {
    for (let b = 0; b < numBlocks; b += 1) {
      const block = dataCodewords.slice(offset, offset + dataPerBlock);
      offset += dataPerBlock;
      dataBlocks.push(block);
      ecBlocks.push(rsEncodeBlock(block, ecCount));
    }
  }

  const result: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i]!);
    }
  }
  for (let i = 0; i < ecCount; i += 1) {
    for (const block of ecBlocks) {
      result.push(block[i]!);
    }
  }
  return result;
}

// ── Matrix construction ─────────────────────────────────────────────────────────

interface Grid {
  size: number;
  modules: (boolean | null)[][]; // null = not yet set (data area)
  reserved: boolean[][]; // true = function pattern / format / version (never masked)
}

function makeGrid(version: number): Grid {
  const size = version * 4 + 17;
  const modules: (boolean | null)[][] = Array.from({ length: size }, () =>
    new Array<boolean | null>(size).fill(null),
  );
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  return { size, modules, reserved };
}

function setModule(grid: Grid, r: number, c: number, dark: boolean, reserve: boolean): void {
  grid.modules[r]![c] = dark;
  if (reserve) grid.reserved[r]![c] = true;
}

function placeFinder(grid: Grid, row: number, col: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= grid.size || cc < 0 || cc >= grid.size) continue;
      const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
      const isCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (isBorder || isCore);
      setModule(grid, rr, cc, dark, true);
    }
  }
}

function placeAlignment(grid: Grid, version: number): void {
  const centers = ALIGNMENT_CENTERS[version]!;
  for (const cr of centers) {
    for (const cc of centers) {
      // Skip the three that overlap finder patterns.
      const nearFinder =
        (cr === 6 && cc === 6) ||
        (cr === 6 && cc === grid.size - 7) ||
        (cr === grid.size - 7 && cc === 6);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          setModule(grid, cr + r, cc + c, dark, true);
        }
      }
    }
  }
}

function placeTiming(grid: Grid): void {
  for (let i = 8; i < grid.size - 8; i += 1) {
    const dark = i % 2 === 0;
    if (grid.modules[6]![i] === null) setModule(grid, 6, i, dark, true);
    if (grid.modules[i]![6] === null) setModule(grid, i, 6, dark, true);
  }
}

/** Reserve (mark, value irrelevant until written) the format and version areas. */
function reserveFormatAndVersion(grid: Grid, version: number): void {
  const size = grid.size;
  // Format info: around the top-left finder, and split near the other two.
  for (let i = 0; i <= 8; i += 1) {
    if (grid.modules[8]![i] === null) setModule(grid, 8, i, false, true);
    if (grid.modules[i]![8] === null) setModule(grid, i, 8, false, true);
  }
  for (let i = 0; i < 8; i += 1) {
    setModule(grid, 8, size - 1 - i, false, true);
    setModule(grid, size - 1 - i, 8, false, true);
  }
  // Dark module — always dark, always reserved.
  setModule(grid, size - 8, 8, true, true);

  // Version info (v7+): two 3×6 blocks.
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const r = Math.floor(i / 3);
      const c = i % 3;
      setModule(grid, r, size - 11 + c, false, true);
      setModule(grid, size - 11 + c, r, false, true);
    }
  }
}

function buildFunctionGrid(version: number): Grid {
  const grid = makeGrid(version);
  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, grid.size - 7);
  placeFinder(grid, grid.size - 7, 0);
  placeAlignment(grid, version);
  placeTiming(grid);
  reserveFormatAndVersion(grid, version);
  return grid;
}

/** Lay the codeword bitstream into the data area in the standard zigzag. */
function placeData(grid: Grid, codewords: number[]): void {
  const bits: number[] = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((cw >>> i) & 1);
  }
  let bitIndex = 0;
  const size = grid.size;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    const c = col === 6 ? col - 1 : col; // skip the vertical timing column
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k += 1) {
        const cc = c - k;
        if (grid.reserved[row]![cc] || grid.modules[row]![cc] !== null) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex]! : 0;
        grid.modules[row]![cc] = bit === 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function maskFn(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      throw new Error(`QR: invalid mask ${mask}`);
  }
}

function applyMask(grid: Grid, mask: number): boolean[][] {
  const size = grid.size;
  const out: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      let dark = grid.modules[r]![c] ?? false;
      if (!grid.reserved[r]![c] && maskFn(mask, r, c)) dark = !dark;
      out[r]![c] = dark;
    }
  }
  return out;
}

// Format information: BCH(15,5) with generator 0x537, XOR mask 0x5412.
function formatBits(ec: QrEcLevel, mask: number): number {
  const ecBits = ec === "L" ? 0b01 : 0b00; // M = 00, L = 01
  const data = (ecBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) & 1 ? 0x537 : 0);
  return ((data << 10) | rem) ^ 0x5412;
}

// Version information: BCH(18,6) with generator 0x1f25. Only for v7+.
function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) & 1 ? 0x1f25 : 0);
  return (version << 12) | rem;
}

function writeFormat(matrix: boolean[][], size: number, ec: QrEcLevel, mask: number): void {
  const bits = formatBits(ec, mask);
  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >>> i) & 1) === 1;
    // Copy 1 (top-left).
    if (i < 6) matrix[8]![i] = bit;
    else if (i === 6) matrix[8]![7] = bit;
    else if (i === 7) matrix[8]![8] = bit;
    else if (i === 8) matrix[7]![8] = bit;
    else matrix[14 - i]![8] = bit;
    // Copy 2 (split across the other two finders).
    if (i < 8) matrix[size - 1 - i]![8] = bit;
    else matrix[8]![size - 15 + i] = bit;
  }
  matrix[size - 8]![8] = true; // dark module
}

function writeVersion(matrix: boolean[][], size: number, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >>> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    matrix[r]![size - 11 + c] = bit;
    matrix[size - 11 + c]![r] = bit;
  }
}

// ── Mask penalty scoring (four rules from the spec) ─────────────────────────────

function penalty(matrix: boolean[][]): number {
  const n = matrix.length;
  let score = 0;

  // Rule 1: runs of 5+ same-colour modules in a row/column.
  for (let r = 0; r < n; r += 1) {
    for (let dir = 0; dir < 2; dir += 1) {
      let run = 1;
      let prev = dir === 0 ? matrix[r]![0] : matrix[0]![r];
      for (let i = 1; i < n; i += 1) {
        const cur = dir === 0 ? matrix[r]![i] : matrix[i]![r];
        if (cur === prev) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
          prev = cur;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: 2×2 blocks of one colour.
  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      const v = matrix[r]![c];
      if (v === matrix[r]![c + 1] && v === matrix[r + 1]![c] && v === matrix[r + 1]![c + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns (with 4 light modules) in rows/cols.
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get: (i: number) => boolean, start: number, pat: boolean[]): boolean => {
    for (let k = 0; k < pat.length; k += 1) if (get(start + k) !== pat[k]) return false;
    return true;
  };
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c <= n - 11; c += 1) {
      if (matches((i) => matrix[r]![i]!, c, pat1) || matches((i) => matrix[r]![i]!, c, pat2)) {
        score += 40;
      }
      if (matches((i) => matrix[i]![r]!, c, pat1) || matches((i) => matrix[i]![r]!, c, pat2)) {
        score += 40;
      }
    }
  }

  // Rule 4: overall dark/light balance.
  let dark = 0;
  for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (matrix[r]![c]) dark += 1;
  const percent = (dark * 100) / (n * n);
  const prev5 = Math.floor(percent / 5) * 5;
  score += (Math.min(Math.abs(prev5 - 50), Math.abs(prev5 + 5 - 50)) / 5) * 10;

  return score;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface QrRenderOptions {
  ecLevel?: QrEcLevel;
  /** Module size in px. Default 4. */
  moduleSize?: number;
  /** Quiet-zone width in modules on each side. Default 4 (spec minimum). */
  quietModules?: number;
}

/**
 * Encode text into a QR module matrix (true = dark). Deterministic: the best
 * mask is chosen by the spec's own penalty score, so identical input yields an
 * identical matrix.
 */
export function qrMatrix(text: string, ecLevel: QrEcLevel = "M"): boolean[][] {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("QR: cannot encode an empty string");
  }
  const { version, codewords } = buildCodewords(text, ecLevel);
  const base = buildFunctionGrid(version);
  placeData(base, codewords);

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(base, mask);
    writeFormat(candidate, base.size, ecLevel, mask);
    writeVersion(candidate, base.size, version);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      bestMask = mask;
    }
  }
  if (!best) throw new Error("QR: mask selection failed");
  void bestMask;
  return best;
}

/**
 * Render text as a self-contained QR SVG string (black modules on a white quiet
 * zone). No external resources, no script — prints crisply at any physical size.
 */
export function renderQrSvg(text: string, options: QrRenderOptions = {}): string {
  const moduleSize = options.moduleSize ?? 4;
  const quiet = options.quietModules ?? 4;
  const matrix = qrMatrix(text, options.ecLevel ?? "M");
  const n = matrix.length;
  const dimension = (n + quiet * 2) * moduleSize;

  const rects: string[] = [];
  for (let r = 0; r < n; r += 1) {
    let c = 0;
    while (c < n) {
      if (!matrix[r]![c]) {
        c += 1;
        continue;
      }
      let run = 1;
      while (c + run < n && matrix[r]![c + run]) run += 1;
      const x = (quiet + c) * moduleSize;
      const y = (quiet + r) * moduleSize;
      rects.push(
        `<rect x="${x}" y="${y}" width="${run * moduleSize}" height="${moduleSize}" fill="#000"/>`,
      );
      c += run;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" ` +
    `viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">` +
    `<rect width="${dimension}" height="${dimension}" fill="#fff"/>` +
    rects.join("") +
    `</svg>`
  );
}
