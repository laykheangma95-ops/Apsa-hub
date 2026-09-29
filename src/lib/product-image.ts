/**
 * Product image — shared, pure rules (safe for browser AND server bundles).
 *
 * Nothing here touches storage, the network or the DOM. It is the single
 * definition of what a V1 product photo is allowed to be, so the browser's
 * early validation and the server's authoritative validation cannot drift.
 *
 * V1 scope: ONE primary image per Product (products.image_path). Raster
 * formats only. SVG is refused on purpose — it is an XML document that can
 * carry script, and V1 has no sanitisation path for it. HEIC/HEIF is refused
 * with its own message: the stack cannot decode or display it reliably, and a
 * clear "please use JPEG" beats a silent failure.
 *
 * Object naming: `<organization_id>/<product_id>/<random uuid>.<ext>`.
 * The name is always generated server-side; a user filename never becomes part
 * of a storage path (no traversal, no injection, no overwrite of an old photo).
 */

export const PRODUCT_IMAGE_BUCKET = "product-images";

/** Largest object the server/bucket will keep. */
export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Largest file the browser will even try to read. Phone photos are commonly
 * 3–10 MB; the browser downscales them before upload (see prepareImageForUpload
 * in the component layer), so the input limit is deliberately looser than the
 * stored limit.
 */
export const PRODUCT_IMAGE_MAX_INPUT_BYTES = 15 * 1024 * 1024;

/** Longest edge, in px, the browser downscales to before upload. */
export const PRODUCT_IMAGE_MAX_EDGE = 1600;

export const PRODUCT_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ProductImageMime = (typeof PRODUCT_IMAGE_MIME_TYPES)[number];

const EXT_BY_MIME: Record<ProductImageMime, "jpg" | "png" | "webp"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** `accept` attribute for the file input. Explicit types, never `image/*`. */
export const PRODUCT_IMAGE_ACCEPT = PRODUCT_IMAGE_MIME_TYPES.join(",");

export type ProductImageErrorKind =
  | "unsupported_type"
  | "heic_unsupported"
  | "too_large"
  | "empty"
  | "corrupt"
  | "upload_failed"
  | "save_failed"
  | "remove_failed"
  | "forbidden"
  | "not_found"
  | "network";

export function isProductImageMime(value: string): value is ProductImageMime {
  return (PRODUCT_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

export function extensionForMime(mime: ProductImageMime): "jpg" | "png" | "webp" {
  return EXT_BY_MIME[mime];
}

export function mimeForExtension(ext: string): ProductImageMime | null {
  switch (ext) {
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

const HEIC_MIMES = new Set(["image/heic", "image/heif", "image/heic-sequence"]);

/**
 * Early (declared-metadata) check, used by both sides before any bytes move.
 * The browser-declared type is only a hint — the server re-checks the actual
 * bytes with sniffImageMime() before it will point a product at the object.
 */
export function checkDeclaredImage(input: {
  mimeType: string;
  sizeBytes: number;
  fileName?: string | undefined;
  maxBytes?: number | undefined;
}): { ok: true; mime: ProductImageMime } | { ok: false; kind: ProductImageErrorKind } {
  const mime = input.mimeType.trim().toLowerCase();
  const name = (input.fileName ?? "").toLowerCase();
  if (HEIC_MIMES.has(mime) || /\.(heic|heif)$/.test(name)) {
    return { ok: false, kind: "heic_unsupported" };
  }
  if (!isProductImageMime(mime)) return { ok: false, kind: "unsupported_type" };
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    return { ok: false, kind: "empty" };
  }
  if (input.sizeBytes > (input.maxBytes ?? PRODUCT_IMAGE_MAX_BYTES)) {
    return { ok: false, kind: "too_large" };
  }
  return { ok: true, mime };
}

/**
 * Identify the real format from the first bytes (magic numbers) only. This is
 * a cheap pre-filter; it accepts a bare 3-byte JPEG signature, so it proves
 * nothing about the file. The server's gate is inspectImageStructure() below.
 */
export function sniffImageMime(bytes: Uint8Array): ProductImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/**
 * Bytes the server reads from the start of an uploaded object to prove its
 * structure. 128 KiB covers a JPEG's leading metadata segments (EXIF, ICC,
 * XMP) up to the frame header on real photos; the browser also re-encodes
 * before upload, which drops most metadata. A file whose frame header is not
 * reached inside the probe is refused (fail closed), never fully downloaded.
 */
export const PRODUCT_IMAGE_PROBE_BYTES = 128 * 1024;

/**
 * Dimension bounds. The browser downscales to PRODUCT_IMAGE_MAX_EDGE (1600 px)
 * before upload, so honest uploads are far below these. They exist to refuse a
 * small file that decodes to a huge bitmap (decompression bomb) and to keep a
 * low-memory phone from decoding an absurd image. 8192 px per edge and 40 MP
 * still admit any phone photo that was not downscaled.
 */
export const PRODUCT_IMAGE_MAX_DIMENSION = 8192;
export const PRODUCT_IMAGE_MAX_PIXELS = 40_000_000;

export interface ImageStructure {
  mime: ProductImageMime;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(b: Uint8Array, at: number, len: number): string {
  let out = "";
  for (let i = at; i < at + len && i < b.length; i++) out += String.fromCharCode(b[i] as number);
  return out;
}
const u16be = (b: Uint8Array, i: number) => ((b[i] as number) << 8) | (b[i + 1] as number);
const u32be = (b: Uint8Array, i: number) =>
  (b[i] as number) * 0x1000000 +
  (((b[i + 1] as number) << 16) | ((b[i + 2] as number) << 8) | (b[i + 3] as number));
const u32le = (b: Uint8Array, i: number) =>
  (b[i] as number) |
  ((b[i + 1] as number) << 8) |
  ((b[i + 2] as number) << 16) |
  ((b[i + 3] as number) * 0x1000000);

let crcTable: Uint32Array | null = null;
function crc32(b: Uint8Array, from: number, to: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = from; i < to; i++)
    c = (crcTable[(c ^ (b[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dimensionsOk(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= PRODUCT_IMAGE_MAX_DIMENSION &&
    height <= PRODUCT_IMAGE_MAX_DIMENSION &&
    width * height <= PRODUCT_IMAGE_MAX_PIXELS
  );
}

function jpegStructure(b: Uint8Array): ImageStructure | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null; // not at a marker: corrupt structure
    while (b[i] === 0xff && i < b.length) i++; // fill bytes
    if (i >= b.length) return null;
    const marker = b[i] as number;
    i++;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // EOI or scan data before any frame header: no dimensions, not an image.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (i + 2 > b.length) return null;
    const len = u16be(b, i);
    if (len < 2 || i + len > b.length) return null; // truncated segment
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 8) return null;
      const components = b[i + 7] as number;
      if (components < 1 || len < 8 + 3 * components) return null;
      const height = u16be(b, i + 3);
      const width = u16be(b, i + 5);
      return dimensionsOk(width, height) ? { mime: "image/jpeg", width, height } : null;
    }
    i += len;
  }
  return null;
}

function pngStructure(b: Uint8Array): ImageStructure | null {
  // signature(8) + length(4) + "IHDR"(4) + data(13) + crc(4)
  if (b.length < 33 || !PNG_SIGNATURE.every((v, i) => b[i] === v)) return null;
  if (u32be(b, 8) !== 13 || ascii(b, 12, 4) !== "IHDR") return null;
  if (u32be(b, 29) !== crc32(b, 12, 29)) return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const depth = b[24] as number;
  const colorType = b[25] as number;
  const allowedDepths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (!allowedDepths[colorType]?.includes(depth)) return null;
  if (b[26] !== 0 || b[27] !== 0 || (b[28] as number) > 1) return null;
  return dimensionsOk(width, height) ? { mime: "image/png", width, height } : null;
}

function webpStructure(b: Uint8Array, totalBytes: number | undefined): ImageStructure | null {
  if (b.length < 20 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const riffEnd = u32le(b, 4) + 8;
  if (riffEnd < 20) return null;
  // The container claims more bytes than the object has: truncated.
  if (totalBytes !== undefined && riffEnd > totalBytes) return null;

  let i = 12;
  let canvas: { width: number; height: number } | null = null;
  while (i + 8 <= b.length) {
    const fourcc = ascii(b, i, 4);
    const size = u32le(b, i + 4);
    const dataAt = i + 8;
    if (dataAt + size > riffEnd) return null; // chunk runs past the container
    if (fourcc === "VP8X") {
      if (size < 10 || dataAt + 10 > b.length || canvas) return null;
      if ((b[dataAt] as number) & 0x02) return null; // animation: not a V1 still photo
      canvas = {
        width:
          1 +
          ((b[dataAt + 4] as number) |
            ((b[dataAt + 5] as number) << 8) |
            ((b[dataAt + 6] as number) << 16)),
        height:
          1 +
          ((b[dataAt + 7] as number) |
            ((b[dataAt + 8] as number) << 8) |
            ((b[dataAt + 9] as number) << 16)),
      };
    } else if (fourcc === "VP8 ") {
      if (size < 10 || dataAt + 10 > b.length) return null;
      if (((b[dataAt] as number) & 0x01) !== 0) return null; // must be a key frame
      if (b[dataAt + 3] !== 0x9d || b[dataAt + 4] !== 0x01 || b[dataAt + 5] !== 0x2a) return null;
      const width = u16le(b, dataAt + 6) & 0x3fff;
      const height = u16le(b, dataAt + 8) & 0x3fff;
      if (canvas && (canvas.width !== width || canvas.height !== height)) return null;
      return dimensionsOk(width, height) ? { mime: "image/webp", width, height } : null;
    } else if (fourcc === "VP8L") {
      if (size < 5 || dataAt + 5 > b.length || b[dataAt] !== 0x2f) return null;
      const bits = u32le(b, dataAt + 1);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      if (canvas && (canvas.width !== width || canvas.height !== height)) return null;
      return dimensionsOk(width, height) ? { mime: "image/webp", width, height } : null;
    } else if (fourcc === "ANIM" || fourcc === "ANMF") {
      return null;
    } else if (!canvas) {
      return null; // a simple file must start with VP8 / VP8L; extended with VP8X
    }
    i = dataAt + size + (size & 1);
  }
  return null; // no image payload chunk inside the probe
}

const u16le = (b: Uint8Array, i: number) => (b[i] as number) | ((b[i + 1] as number) << 8);

/**
 * Prove an object is minimally structurally a JPEG, PNG or WebP still image
 * from a bounded leading probe (PRODUCT_IMAGE_PROBE_BYTES) and derive its
 * dimensions. Refuses signature-only / header-only / truncated headers,
 * malformed segments or chunks, animated WebP, and out-of-bound dimensions.
 *
 * This is structural, not a decode: a well-formed header on a corrupt scan
 * body still passes. It exists to stop spoofed files, not to replace the
 * browser's own decoder (a bad file just shows the placeholder).
 * `totalBytes` is the object's verified total size (used for WebP truncation).
 */
export function inspectImageStructure(
  bytes: Uint8Array,
  totalBytes?: number,
): ImageStructure | null {
  switch (sniffImageMime(bytes)) {
    case "image/jpeg":
      return jpegStructure(bytes);
    case "image/png":
      return pngStructure(bytes);
    case "image/webp":
      return webpStructure(bytes, totalBytes);
    default:
      return null;
  }
}

// ── Object paths ─────────────────────────────────────────────────────────────

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "i");

/** Server-generated object path. Inputs must already be trusted UUIDs. */
export function buildProductImagePath(
  organizationId: string,
  productId: string,
  objectId: string,
  mime: ProductImageMime,
): string {
  if (!UUID_RE.test(organizationId) || !UUID_RE.test(productId) || !UUID_RE.test(objectId)) {
    throw new Error("buildProductImagePath: ids must be UUIDs");
  }
  return `${organizationId}/${productId}/${objectId}.${EXT_BY_MIME[mime]}`.toLowerCase();
}

/**
 * True only for a path in EXACTLY the shape buildProductImagePath produces,
 * inside THIS organization's and THIS product's namespace. Anything else — a
 * different org, a different product, `..` segments, extra folders, a raw
 * filename — is rejected. This is the server's gate before it will attach an
 * object to a product; the products.image_path CHECK constraint (migration
 * 048) enforces the same shape in the database.
 */
export function isOwnedProductImagePath(
  path: unknown,
  organizationId: string,
  productId: string,
): path is string {
  if (typeof path !== "string" || path.length > 200) return false;
  if (!UUID_RE.test(organizationId) || !UUID_RE.test(productId)) return false;
  // Lower-case and case-sensitive on purpose: identical to the DB CHECK.
  const re = new RegExp(
    `^${organizationId.toLowerCase()}/${productId.toLowerCase()}/${UUID}\\.(jpg|png|webp)$`,
  );
  return re.test(path);
}

export function mimeFromProductImagePath(path: string): ProductImageMime | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return mimeForExtension(ext);
}
