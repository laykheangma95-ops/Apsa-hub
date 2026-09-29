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
/**
 * UNRESOLVED-ticket caps (migration 050): pending (live or expired but not yet
 * cleaned), claimed and cleaning tickets all count. An expired ticket keeps
 * counting until its object is really deleted, so cleanup that keeps failing
 * eventually stops new upload authority instead of letting storage grow.
 */
export const PRODUCT_IMAGE_MAX_OUTSTANDING_MEMBER = 30;
export const PRODUCT_IMAGE_MAX_OUTSTANDING_ORGANIZATION = 100;
/** Tickets a sweep takes per call — bounds the work added to a ticket request. */
export const PRODUCT_IMAGE_SWEEP_BATCH = 25;
/** How long one attach may own a ticket before a crashed attach is recoverable. */
export const PRODUCT_IMAGE_CLAIM_SECONDS = 120;
/** How long a sweep owns a ticket before a crashed sweep is retried. */
export const PRODUCT_IMAGE_CLEANUP_LEASE_SECONDS = 10 * 60;

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
 * Delete abandoned uploads. The database takes a bounded batch of eligible
 * tickets (expired, and not under an active claim) and marks them `cleaning`;
 * see migration 050 for eligibility. Across tenants — server housekeeping,
 * nothing from the rows is returned to any caller.
 *
 * Safety: an object is deleted only when (1) the database handed its ticket out
 * (so no attach owns it), (2) its path has exactly the shape its own ticket's
 * org + product produce, and (3) NO product currently references it — this last
 * check is independent of ticket state, so a current product image is never
 * removed even if its ticket was left in any state.
 *
 * Every row is processed independently: a failed delete keeps that ticket
 * unresolved (it still counts against the backlog caps) with a retry delay, and
 * later rows are unaffected. Never throws: a sweep failure must not block ticket
 * issuance, reads, or anything else.
 */
export async function sweepExpiredProductImageUploads(): Promise<{
  resolved: number;
  failed: number;
}> {
  try {
    const taken = await repo.takeUploadTicketsForCleanup(
      PRODUCT_IMAGE_SWEEP_BATCH,
      PRODUCT_IMAGE_CLEANUP_LEASE_SECONDS,
    );
    if (taken.length === 0) return { resolved: 0, failed: 0 };

    const referenced = await repo.findReferencedImagePaths(taken.map((t) => t.object_path));
    const resolved: string[] = [];
    const failed: string[] = [];
    await Promise.all(
      taken.map(async (t) => {
        const ownedShape = isOwnedProductImagePath(t.object_path, t.organization_id, t.product_id);
        if (referenced.has(t.object_path) || !ownedShape) {
          // Never delete an object we cannot prove is an abandoned upload.
          resolved.push(t.id);
          return;
        }
        try {
          await getProductImageStorage().remove([t.object_path]);
          resolved.push(t.id);
        } catch {
          failed.push(t.id);
        }
      }),
    );
    await repo.deleteCleanedTickets(resolved);
    await repo.recordCleanupFailures(failed);
    if (failed.length > 0)
      serverLog.warn("product_image.sweep_delete_failed", { count: failed.length });
    return { resolved: resolved.length, failed: failed.length };
  } catch {
    serverLog.warn("product_image.sweep_failed", {});
    return { resolved: 0, failed: 0 };
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
  try {
    // One atomic, serialized database operation: caps are counted over
    // UNRESOLVED tickets and the ticket is inserted in the same transaction.
    const issued = await repo.issueUploadTicket({
      organizationId: ctx.organizationId,
      productId: product.id,
      issuedBy: ctx.userId,
      objectPath: path,
      ttlSeconds: PRODUCT_IMAGE_TICKET_TTL_SECONDS,
      memberCap: PRODUCT_IMAGE_MAX_OUTSTANDING_MEMBER,
      organizationCap: PRODUCT_IMAGE_MAX_OUTSTANDING_ORGANIZATION,
    });
    if (issued !== "ok") {
      throw publicError(
        "Too many photo uploads are waiting to be saved. Please try again later.",
        429,
      );
    }
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
    // The URL was never signed: the ticket is safe to drop.
    await repo.deleteUnsignedTicket(ctx.organizationId, product.id, path).catch(() => undefined);
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

/** Give a claim back so the ticket stays usable/cleanable; a failure just lets the claim lapse. */
async function releaseClaim(orgId: string, productId: string, path: string): Promise<void> {
  await repo.releaseUploadClaim(orgId, productId, path).catch(() => undefined);
}

/**
 * Remove a rejected object AND resolve its (claimed) ticket. If the object
 * cannot be deleted the claim is released, so the ticket stays unresolved — and
 * counted — until the expiry sweep deletes the object.
 */
async function discardUpload(
  orgId: string,
  productId: string,
  path: string,
  event: string,
): Promise<void> {
  try {
    await getProductImageStorage().remove([path]);
  } catch {
    serverLog.warn(event, { productId, count: 1 });
    await releaseClaim(orgId, productId, path);
    return;
  }
  await repo.resolveUploadTicket(orgId, productId, path).catch(() => undefined);
}

/**
 * Step 2 of upload/replace: claim the ticket, verify the uploaded object, then
 * attach it. Returns the new display URL.
 *
 *   1. atomically CLAIM a live pending ticket (before any storage or product
 *      access) — a duplicate or racing attach cannot claim it and fails safely;
 *      an active claim protects the object from the cleanup sweep
 *   2. inspect + validate the object
 *   3. FINALIZE: ticket -> consumed AND product -> new image, one transaction
 *   4. delete the previous object, best effort
 *
 * Invalid content: object deleted, ticket resolved. Transient failure before the
 * product changed: the claim is released (retryable; otherwise it lapses after
 * PRODUCT_IMAGE_CLAIM_SECONDS). Once finalized the object is never deleted here.
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

  let claimed: boolean;
  try {
    claimed = await repo.claimUploadTicket(
      ctx.organizationId,
      product.id,
      path,
      PRODUCT_IMAGE_CLAIM_SECONDS,
    );
  } catch {
    serverLog.error("product_image.ticket_claim_failed", { productId });
    throw publicError("Could not verify the upload. Please try again.", 503);
  }
  // No live pending ticket for exactly this org + product + path (never issued,
  // expired, already claimed or consumed): fail closed.
  if (!claimed) {
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
    await releaseClaim(ctx.organizationId, product.id, path);
    throw publicError("Could not verify the upload. Please try again.", 503);
  }
  if (!inspection) {
    // Nothing landed (yet): give the claim back so the client may retry.
    await releaseClaim(ctx.organizationId, product.id, path);
    throw invalid();
  }

  const declaredMime = mimeFromProductImagePath(path);
  const tooBig = inspection.sizeBytes > PRODUCT_IMAGE_MAX_BYTES || inspection.sizeBytes <= 0;
  const structure = tooBig ? null : inspectImageStructure(inspection.head, inspection.sizeBytes);
  if (!declaredMime || structure?.mime !== declaredMime || tooBig) {
    // Wrong/truncated/spoofed bytes for the claimed type (or oversize): delete
    // the stray object and refuse. The product is untouched.
    await discardUpload(
      ctx.organizationId,
      product.id,
      path,
      "product_image.reject_cleanup_failed",
    );
    throw publicError(
      tooBig ? "This image is too large." : "This file is not a valid JPEG, PNG or WebP image.",
      400,
    );
  }

  let finalized: { previousPath: string | null } | null;
  try {
    finalized = await repo.finalizeUploadTicket(ctx.organizationId, product.id, path);
  } catch {
    // Nothing changed (the database function is one transaction): the product
    // keeps its previous image and the upload stays retryable / cleanable. The
    // object is NOT deleted here — the outcome may be unknown to us.
    serverLog.error("product_image.attach_failed", { productId });
    await releaseClaim(ctx.organizationId, product.id, path);
    throw publicError("Could not save the photo. Please try again.", 500);
  }
  // Lost the ticket (e.g. cleanup took it after a lapsed claim): nothing changed.
  if (!finalized) throw invalid();

  // The product references the object and the ticket is consumed. Only now
  // retire the previous object, best effort.
  const previousPath = finalized.previousPath;
  if (previousPath && previousPath !== path) {
    await bestEffortRemove([previousPath], "product_image.old_cleanup_failed", productId);
  }

  const urls = await resolveImageUrls([{ ...product, image_path: path }]);
  return { imageUrl: urls.get(product.id) ?? null };
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
