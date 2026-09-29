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
  inspectImageStructure,
  isOwnedProductImagePath,
  mimeFromProductImagePath,
  type ProductImageErrorKind,
} from "@/lib/product-image";
import { enforceRateLimits } from "@/server/rate-limit/limiter";
import { BACKEND_FAILURE_POLICY, RATE_LIMITS } from "@/server/rate-limit/policies";
import * as repo from "./repository";
import { PRODUCT_IMAGE_READ_TTL_SECONDS, getProductImageStorage } from "./image-storage";
import type { ProductRow } from "./types";

const UPLOAD_MESSAGES: Partial<Record<ProductImageErrorKind, string>> = {
  unsupported_type: "Unsupported image type. Use a JPEG, PNG or WebP photo.",
  heic_unsupported: "HEIC photos are not supported yet. Use a JPEG, PNG or WebP photo.",
  too_large: "This image is too large.",
  empty: "This image file is empty.",
};

/**
 * Upload tickets. Supabase signs an upload URL for 2 hours; the ticket outlives
 * it by an hour, so once a ticket is expired no upload can still land and the
 * sweep can safely delete whatever object is there.
 */
export const PRODUCT_IMAGE_TICKET_TTL_SECONDS = 3 * 60 * 60;
/** Issued-but-unattached tickets one member / one organization may hold at once. */
export const PRODUCT_IMAGE_MAX_OUTSTANDING_MEMBER = 30;
export const PRODUCT_IMAGE_MAX_OUTSTANDING_ORGANIZATION = 100;
/** Expired tickets swept per ticket request — bounds the work added to it. */
export const PRODUCT_IMAGE_SWEEP_BATCH = 25;

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
 * Delete abandoned uploads: tickets that expired without being attached.
 * Oldest first, at most PRODUCT_IMAGE_SWEEP_BATCH per call, across tenants
 * (server housekeeping; nothing from the rows is returned to any caller).
 *
 * Safety: an object is deleted only when (1) its ticket is expired, (2) its
 * path is in exactly the shape its own ticket's org + product produce, and
 * (3) NO product currently references it. A current product image is never
 * removed, even if its ticket row was left behind. The ticket row is removed
 * only after the object is gone (or was never deletable), so a failed storage
 * delete is retried by the next sweep. Never throws: a sweep failure must not
 * block ticket issuance, reads, or anything else.
 */
export async function sweepExpiredProductImageUploads(
  now: Date = new Date(),
): Promise<{ removed: number; released: number }> {
  try {
    const expired = await repo.listExpiredUploadTickets(
      now.toISOString(),
      PRODUCT_IMAGE_SWEEP_BATCH,
    );
    if (expired.length === 0) return { removed: 0, released: 0 };

    const wellFormed = expired.filter((t) =>
      isOwnedProductImagePath(t.object_path, t.organization_id, t.product_id),
    );
    const referenced = await repo.findReferencedImagePaths(wellFormed.map((t) => t.object_path));
    const deletable = wellFormed.map((t) => t.object_path).filter((p) => !referenced.has(p));

    if (deletable.length > 0) await getProductImageStorage().remove(deletable);
    await repo.deleteUploadTickets(expired.map((t) => t.object_path));
    return { removed: deletable.length, released: expired.length - deletable.length };
  } catch {
    serverLog.warn("product_image.sweep_failed", {});
    return { removed: 0, released: 0 };
  }
}

/**
 * Step 1 of upload/replace: authorize, bound abuse, validate the declared
 * file, record a ticket, and mint a server-generated object path plus a signed
 * upload URL bound to it.
 *
 * Abuse bounds (all server-side, derived from the verified session — never
 * from client input): a durable per-member and per-organization issuance rate
 * limit that FAILS CLOSED if the limiter is unavailable, and a cap on
 * outstanding unattached tickets. The ticket row is written BEFORE the URL is
 * signed, so no signed URL exists without a ticket the sweep can find.
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

  await enforceRateLimits(
    [
      { rule: RATE_LIMITS.productImageUploadMember, parts: [ctx.organizationId, ctx.userId] },
      { rule: RATE_LIMITS.productImageUploadOrganization, parts: [ctx.organizationId] },
    ],
    undefined,
    { onBackendFailure: BACKEND_FAILURE_POLICY.productImageUpload },
  );

  const product = await repo.findProductById(ctx.organizationId, productId);
  if (!product) throw publicError("Product not found", 404);

  // Opportunistic, bounded, never throws.
  await sweepExpiredProductImageUploads();

  const path = buildProductImagePath(
    ctx.organizationId,
    product.id,
    globalThis.crypto.randomUUID(),
    checked.mime,
  );
  const nowIso = new Date().toISOString();
  try {
    const [mine, org] = await Promise.all([
      repo.countOutstandingUploadTickets(
        ctx.organizationId,
        ctx.userId,
        nowIso,
        PRODUCT_IMAGE_MAX_OUTSTANDING_MEMBER,
      ),
      repo.countOutstandingUploadTickets(
        ctx.organizationId,
        null,
        nowIso,
        PRODUCT_IMAGE_MAX_OUTSTANDING_ORGANIZATION,
      ),
    ]);
    if (
      mine >= PRODUCT_IMAGE_MAX_OUTSTANDING_MEMBER ||
      org >= PRODUCT_IMAGE_MAX_OUTSTANDING_ORGANIZATION
    ) {
      throw publicError(
        "Too many photo uploads are waiting to be saved. Please try again later.",
        429,
      );
    }
    await repo.insertUploadTicket({
      organizationId: ctx.organizationId,
      productId: product.id,
      issuedBy: ctx.userId,
      objectPath: path,
      expiresAt: new Date(Date.now() + PRODUCT_IMAGE_TICKET_TTL_SECONDS * 1000).toISOString(),
    });
  } catch (err) {
    if (isPublicDomainError(err)) throw err;
    serverLog.error("product_image.ticket_record_failed", { productId });
    throw publicError("Could not start the upload. Please try again.", 503);
  }

  try {
    const signed = await getProductImageStorage().createUpload(path);
    return { path, uploadUrl: signed.signedUrl };
  } catch {
    serverLog.error("product_image.upload_ticket_failed", { productId });
    await repo.deleteUploadTickets([path]).catch(() => undefined);
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
 * Remove a rejected object AND its ticket. If the object cannot be deleted the
 * ticket is kept, so the expiry sweep retries the deletion.
 */
async function discardUpload(path: string, event: string, productId: string): Promise<void> {
  try {
    await getProductImageStorage().remove([path]);
  } catch {
    serverLog.warn(event, { productId, count: 1 });
    return;
  }
  await repo.deleteUploadTickets([path]).catch(() => undefined);
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

  // Only an object this server issued a live ticket for can be attached.
  let ticket;
  try {
    ticket = await repo.findLiveUploadTicket(
      ctx.organizationId,
      product.id,
      path,
      new Date().toISOString(),
    );
  } catch {
    serverLog.error("product_image.ticket_lookup_failed", { productId });
    throw publicError("Could not verify the upload. Please try again.", 503);
  }
  if (!ticket) {
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
  const tooBig = inspection.sizeBytes > PRODUCT_IMAGE_MAX_BYTES || inspection.sizeBytes <= 0;
  const structure = tooBig ? null : inspectImageStructure(inspection.head, inspection.sizeBytes);
  if (!declaredMime || structure?.mime !== declaredMime || tooBig) {
    // Wrong/truncated/spoofed bytes for the claimed type (or oversize): delete
    // the stray object and refuse. The product is untouched.
    await discardUpload(path, "product_image.reject_cleanup_failed", productId);
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
    await discardUpload(path, "product_image.attach_cleanup_failed", productId);
    throw publicError("Could not save the photo. Please try again.", 500);
  }
  if (!updated) throw publicError("Product not found", 404);

  // The product references the object: consume the ticket. If this fails the
  // sweep still cannot delete the object — it skips any referenced path.
  await repo.deleteUploadTickets([path]).catch(() => {
    serverLog.warn("product_image.ticket_consume_failed", { productId });
  });

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
