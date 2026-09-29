/**
 * Product image — browser-side upload orchestration.
 *
 * Talks only to the server functions in @/api/products (dynamically imported,
 * so no server-only module enters the browser bundle) and to the signed upload
 * URL those functions hand back. There is no Supabase client, no service key
 * and no client-chosen storage path anywhere in this file.
 *
 * Ordering guarantee (the reason `attach` is a separate step): the product row
 * is only re-pointed AFTER the bytes were uploaded and the server verified
 * them. A failed or interrupted upload never reaches `attach`, so an existing
 * photo is never touched by a failed replace.
 */
import {
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_MAX_EDGE,
  PRODUCT_IMAGE_MAX_INPUT_BYTES,
  checkDeclaredImage,
  isProductImageMime,
  type ProductImageErrorKind,
  type ProductImageMime,
} from "@/lib/product-image";

// ── Error classification ─────────────────────────────────────────────────────

export class ProductImageError extends Error {
  readonly kind: ProductImageErrorKind;
  constructor(kind: ProductImageErrorKind) {
    super(kind);
    this.name = "ProductImageError";
    this.kind = kind;
  }
}

/**
 * Map any failure to a fixed kind. Server messages are matched by prefix and
 * only ever used to pick a locale key — raw provider/server text is never
 * rendered to the merchant.
 */
export function classifyProductImageError(err: unknown): ProductImageErrorKind {
  if (err instanceof ProductImageError) return err.kind;
  const message = err instanceof Error ? err.message : "";
  if (
    message.startsWith("Missing permission:") ||
    message === "No active organization membership" ||
    message === "Not authenticated"
  ) {
    return "forbidden";
  }
  if (message === "Product not found") return "not_found";
  if (message.startsWith("HEIC photos")) return "heic_unsupported";
  if (message.startsWith("Unsupported image type")) return "unsupported_type";
  if (message.startsWith("This image is too large")) return "too_large";
  if (message.startsWith("This image file is empty")) return "empty";
  if (message.startsWith("This file is not a valid")) return "corrupt";
  if (message.startsWith("Could not save the photo")) return "save_failed";
  if (message.startsWith("Could not remove the photo")) return "remove_failed";
  if (
    err instanceof TypeError ||
    /network|failed to fetch|load failed|timeout|offline/i.test(message)
  ) {
    return "network";
  }
  return "upload_failed";
}

export function productImageErrorKey(kind: ProductImageErrorKind): string {
  return `catalog.image.error.${kind}`;
}

// ── Local validation + downscale ─────────────────────────────────────────────

/**
 * Early validation of a picked file (declared metadata only; the server sniffs
 * the real bytes). Returns the accepted mime or throws ProductImageError.
 */
export function validatePickedFile(file: {
  type: string;
  size: number;
  name?: string;
}): ProductImageMime {
  const checked = checkDeclaredImage({
    mimeType: file.type,
    sizeBytes: file.size,
    fileName: file.name,
    maxBytes: PRODUCT_IMAGE_MAX_INPUT_BYTES,
  });
  if (!checked.ok) throw new ProductImageError(checked.kind);
  return checked.mime;
}

export interface PreparedImage {
  blob: Blob;
  mime: ProductImageMime;
}

/**
 * Decode the photo, downscale it to PRODUCT_IMAGE_MAX_EDGE and re-encode it.
 * This is what keeps a 6 MB camera photo under the stored-size limit and stops
 * huge originals being served to every list row. Decoding also catches a
 * corrupt file up front. Where the browser cannot decode/encode, a file that is
 * already within the stored limit is uploaded as-is; otherwise "too large".
 */
export async function prepareImageForUpload(file: File): Promise<PreparedImage> {
  const mime = validatePickedFile(file);

  let bitmap: ImageBitmap | null = null;
  try {
    if (typeof createImageBitmap === "function") bitmap = await createImageBitmap(file);
  } catch {
    throw new ProductImageError("corrupt");
  }

  if (!bitmap || typeof document === "undefined") {
    if (file.size > PRODUCT_IMAGE_MAX_BYTES) throw new ProductImageError("too_large");
    return { blob: file, mime };
  }

  const longest = Math.max(bitmap.width, bitmap.height);
  const needsResize = longest > PRODUCT_IMAGE_MAX_EDGE;
  if (!needsResize && file.size <= PRODUCT_IMAGE_MAX_BYTES) {
    bitmap.close();
    return { blob: file, mime };
  }

  const scale = needsResize ? PRODUCT_IMAGE_MAX_EDGE / longest : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    if (file.size > PRODUCT_IMAGE_MAX_BYTES) throw new ProductImageError("too_large");
    return { blob: file, mime };
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const encode = (type: ProductImageMime, quality?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

  // Keep the picked format (PNG keeps transparency); fall back to JPEG/WebP only
  // if the re-encode is still too big or the browser cannot encode that type.
  for (const [type, quality] of [
    [mime, 0.85],
    ["image/webp", 0.85],
    ["image/jpeg", 0.8],
  ] as const) {
    const out = await encode(type, quality);
    if (out && isProductImageMime(out.type) && out.size <= PRODUCT_IMAGE_MAX_BYTES) {
      return { blob: out, mime: out.type };
    }
  }
  throw new ProductImageError("too_large");
}

// ── Upload ───────────────────────────────────────────────────────────────────

export interface UploadDeps {
  requestUpload(input: {
    productId: string;
    mimeType: string;
    sizeBytes: number;
    fileName?: string | undefined;
  }): Promise<{ path: string; uploadUrl: string }>;
  putObject(
    uploadUrl: string,
    blob: Blob,
    onProgress: (fraction: number) => void,
    signal?: AbortSignal | undefined,
  ): Promise<void>;
  attach(input: { productId: string; path: string }): Promise<{ imageUrl: string | null }>;
}

/** PUT to a Supabase signed upload URL (multipart body, mirrors storage-js). */
function putWithProgress(
  uploadUrl: string,
  blob: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    // Never overwrite: object names are unique and server-generated.
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ProductImageError("upload_failed"));
    };
    xhr.onerror = () => reject(new ProductImageError("network"));
    xhr.ontimeout = () => reject(new ProductImageError("network"));
    xhr.onabort = () => reject(new ProductImageError("network"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });

    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", blob);
    xhr.send(body);
  });
}

async function defaultDeps(): Promise<UploadDeps> {
  const api = await import("@/api/products");
  return {
    requestUpload: (input) => api.requestProductImageUploadFn({ data: input }),
    putObject: putWithProgress,
    attach: (input) => api.attachProductImageFn({ data: input }),
  };
}

export interface UploadProductImageOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  deps?: UploadDeps;
}

/**
 * Upload (or replace) a product's photo: request ticket → PUT bytes → attach.
 * Throws ProductImageError-classifiable failures; on ANY failure before
 * `attach` succeeds the product's current image is left exactly as it was.
 */
export async function uploadProductImage(
  productId: string,
  prepared: PreparedImage,
  fileName: string | undefined,
  options: UploadProductImageOptions = {},
): Promise<{ imageUrl: string | null }> {
  const deps = options.deps ?? (await defaultDeps());
  const onProgress = options.onProgress ?? (() => undefined);

  const ticket = await deps.requestUpload({
    productId,
    mimeType: prepared.mime,
    sizeBytes: prepared.blob.size,
    fileName,
  });
  await deps.putObject(ticket.uploadUrl, prepared.blob, onProgress, options.signal);
  return deps.attach({ productId, path: ticket.path });
}

export async function removeProductImage(productId: string): Promise<{ imageUrl: null }> {
  const { removeProductImageFn } = await import("@/api/products");
  return removeProductImageFn({ data: { productId } });
}
