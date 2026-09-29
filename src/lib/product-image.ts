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
 * Identify the real format from the first bytes (magic numbers), ignoring the
 * declared type and the extension. Returns null for anything that is not a
 * JPEG, PNG or WebP — including SVG, HTML, executables and truncated data.
 */
export function sniffImageMime(bytes: Uint8Array): ProductImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Bytes the server needs to read to run sniffImageMime(). */
export const PRODUCT_IMAGE_SNIFF_BYTES = 16;

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
