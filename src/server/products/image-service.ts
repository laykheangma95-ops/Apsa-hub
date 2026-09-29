/**
 * Product image service — authorization + safety rules for the V1 primary photo.
 *
 * Permission model: uploading, replacing and removing a photo are ordinary
 * catalog edits and require `products.update_basic` — exactly the gate on
 * editing a product's name. Reading the resulting URL requires `products.read`
 * (it rides on the normal product reads). A member who can view but not edit a
 * product gets no upload path and no delete path: every entry point below
 * calls ctx.require() before touching a row or storage.
 *
 * Tenant model: the organization always comes from ctx (server-verified
 * membership), never from input. A product is looked up WITH the caller's
 * organization, so another tenant's product id is a plain 404. An object path
 * supplied by the client is only accepted if it is byte-for-byte the shape the
 * server generates AND lives under this organization AND this product; the
 * database CHECK (migration 048) enforces the same rule as a backstop.
 *
 * Safe ordering (replace / remove):
 *   upload new object → verify it → point the product at it → delete the old
 *   object. The old object is only deleted after the product row already
 *   references the new one, and a failed delete only leaves an orphan; it can
 *   never leave a product without the image it was told it has.
 *
 * Errors: only fixed, APSA-written messages cross to the browser. Provider
 * text is logged (scrubbed by the logger) and never shown.
 *
 * Never import this file from browser-bundled code.
 */
import { isPublicDomainError, publicError } from "@/server/public-domain-error";
import type { AuthorizationContext } from "@/server/auth/authorization";
import { serverLog } from "@/server/observability/logger";
import {
  PRODUCT_IMAGE_MAX_BYTES,
  buildProductImagePath,
  checkDeclaredImage,
  isOwnedProductImagePath,
  mimeFromProductImagePath,
  sniffImageMime,
  type ProductImageErrorKind,
} from "@/lib/product-image";
import * as repo from "./repository";
import { PRODUCT_IMAGE_READ_TTL_SECONDS, getProductImageStorage } from "./image-storage";
import type { ProductRow } from "./types";

const UPLOAD_MESSAGES: Partial<Record<ProductImageErrorKind, string>> = {
  unsupported_type: "Unsupported image type. Use a JPEG, PNG or WebP photo.",
  heic_unsupported: "HEIC photos are not supported yet. Use a JPEG, PNG or WebP photo.",
  too_large: "This image is too large.",
  empty: "This image file is empty.",
};

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Sign display URLs for a set of product rows. Failure to sign is NOT a
 * failure to read the catalog: the product simply shows its placeholder. The
 * storage object path itself is never returned to callers.
 */
export async function resolveImageUrls(rows: ProductRow[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const withImage = rows.filter((r) => r.image_path);
  for (const r of rows) out.set(r.id, null);
  if (withImage.length === 0) return out;

  try {
    const signed = await getProductImageStorage().createReadUrls(
      withImage.map((r) => r.image_path as string),
      PRODUCT_IMAGE_READ_TTL_SECONDS,
    );
    for (const r of withImage) out.set(r.id, signed.get(r.image_path as string) ?? null);
  } catch {
    serverLog.warn("product_image.sign_failed", { count: withImage.length });
  }
  return out;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface ProductImageUploadTicket {
  path: string;
  /** Signed PUT URL for exactly `path`; short-lived, single object. */
  uploadUrl: string;
}

/**
 * Step 1 of upload/replace: authorize, validate the declared file, and mint a
 * server-generated object path plus a signed upload URL bound to it.
 */
export async function requestProductImageUpload(
  ctx: AuthorizationContext,
  productId: string,
  file: { mimeType: string; sizeBytes: number; fileName?: string | undefined },
): Promise<ProductImageUploadTicket> {
  ctx.require("products.update_basic");

  const checked = checkDeclaredImage(file);
  if (!checked.ok) {
    throw publicError(UPLOAD_MESSAGES[checked.kind] ?? "Unsupported image.", 400);
  }

  const product = await repo.findProductById(ctx.organizationId, productId);
  if (!product) throw publicError("Product not found", 404);

  const path = buildProductImagePath(
    ctx.organizationId,
    product.id,
    globalThis.crypto.randomUUID(),
    checked.mime,
  );
  try {
    const signed = await getProductImageStorage().createUpload(path);
    return { path, uploadUrl: signed.signedUrl };
  } catch {
    serverLog.error("product_image.upload_ticket_failed", { productId });
    throw publicError("Could not start the upload. Please try again.", 503);
  }
}

async function bestEffortRemove(paths: string[], event: string, productId: string): Promise<void> {
  if (paths.length === 0) return;
  try {
    await getProductImageStorage().remove(paths);
  } catch {
    // Leaves an unreferenced object (an orphan), never a broken product.
    // Path is deliberately not logged: it embeds tenant and product ids.
    serverLog.warn(event, { productId, count: paths.length });
  }
}

/**
 * Step 2 of upload/replace: verify the uploaded object, then attach it.
 * Returns the new display URL.
 */
export async function attachProductImage(
  ctx: AuthorizationContext,
  productId: string,
  path: string,
): Promise<{ imageUrl: string | null }> {
  ctx.require("products.update_basic");

  const product = await repo.findProductById(ctx.organizationId, productId);
  if (!product) throw publicError("Product not found", 404);

  // Cross-tenant / cross-product / traversal / arbitrary-name attempt. The
  // message is identical to "object missing" so it is not a probe oracle.
  if (!isOwnedProductImagePath(path, ctx.organizationId, product.id)) {
    throw publicError("The uploaded image could not be verified. Please try again.", 400);
  }

  const storage = getProductImageStorage();
  const invalid = () =>
    publicError("The uploaded image could not be verified. Please try again.", 400);

  let inspection;
  try {
    inspection = await storage.inspect(path);
  } catch {
    serverLog.error("product_image.inspect_failed", { productId });
    throw publicError("Could not verify the upload. Please try again.", 503);
  }
  if (!inspection) throw invalid();

  const declaredMime = mimeFromProductImagePath(path);
  const realMime = sniffImageMime(inspection.head);
  const tooBig = inspection.sizeBytes > PRODUCT_IMAGE_MAX_BYTES || inspection.sizeBytes <= 0;
  if (!declaredMime || realMime !== declaredMime || tooBig) {
    // Wrong bytes for the claimed type (or oversize): delete the stray object
    // and refuse. The product is untouched.
    await bestEffortRemove([path], "product_image.reject_cleanup_failed", productId);
    throw publicError(
      tooBig ? "This image is too large." : "This file is not a valid JPEG, PNG or WebP image.",
      400,
    );
  }

  const previousPath = product.image_path;
  let updated: ProductRow | null;
  try {
    updated = await repo.setProductImagePath(ctx.organizationId, product.id, path);
  } catch {
    // Save failed AFTER a successful upload: the product still points at its
    // previous image (if any). Drop the new object so it is not orphaned.
    serverLog.error("product_image.attach_failed", { productId });
    await bestEffortRemove([path], "product_image.attach_cleanup_failed", productId);
    throw publicError("Could not save the photo. Please try again.", 500);
  }
  if (!updated) throw publicError("Product not found", 404);

  // Only now — the row already references the new object — retire the old one.
  if (previousPath && previousPath !== path) {
    await bestEffortRemove([previousPath], "product_image.old_cleanup_failed", productId);
  }

  const urls = await resolveImageUrls([updated]);
  return { imageUrl: urls.get(updated.id) ?? null };
}

/** Clear the product's photo. DB reference first, object delete after. */
export async function removeProductImage(
  ctx: AuthorizationContext,
  productId: string,
): Promise<{ imageUrl: null }> {
  ctx.require("products.update_basic");

  const product = await repo.findProductById(ctx.organizationId, productId);
  if (!product) throw publicError("Product not found", 404);
  if (!product.image_path) return { imageUrl: null };

  const previousPath = product.image_path;
  try {
    const updated = await repo.setProductImagePath(ctx.organizationId, product.id, null);
    if (!updated) throw publicError("Product not found", 404);
  } catch (err) {
    if (isPublicDomainError(err)) throw err;
    serverLog.error("product_image.remove_failed", { productId });
    throw publicError("Could not remove the photo. Please try again.", 500);
  }

  await bestEffortRemove([previousPath], "product_image.remove_cleanup_failed", productId);
  return { imageUrl: null };
}
