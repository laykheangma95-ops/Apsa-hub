/**
 * Product image storage adapter — the ONLY place that talks to Supabase
 * Storage for product photos.
 *
 * Uses the service-role client, so it must only ever be called AFTER the
 * service layer has authorized the caller and validated the object path
 * (isOwnedProductImagePath). The bucket is private: nothing here returns a
 * public URL, and nothing here ever hands the service key to a browser — the
 * browser receives only a signed upload URL bound to one server-generated path.
 *
 * Errors thrown from here carry provider text and are NEVER shown to a user;
 * the service maps them to fixed public messages and logs only safe fields.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import { PRODUCT_IMAGE_BUCKET, PRODUCT_IMAGE_SNIFF_BYTES } from "@/lib/product-image";

export interface SignedUpload {
  /** Full signed PUT URL (contains a one-path, short-lived token). */
  signedUrl: string;
  path: string;
}

export interface ObjectInspection {
  /** Total object size in bytes. */
  sizeBytes: number;
  /** First bytes of the object, for magic-number sniffing. */
  head: Uint8Array;
}

export interface ProductImageStorage {
  createUpload(path: string): Promise<SignedUpload>;
  /** Signed read URLs keyed by path; a path that cannot be signed is omitted. */
  createReadUrls(paths: string[], expiresInSeconds: number): Promise<Map<string, string>>;
  /** null when the object does not exist. */
  inspect(path: string): Promise<ObjectInspection | null>;
  remove(paths: string[]): Promise<void>;
}

/** How long a signed read URL stays valid. Long enough for a POS shift screen. */
export const PRODUCT_IMAGE_READ_TTL_SECONDS = 60 * 60;

/** How long the URL used to sniff an object stays valid. */
const INSPECT_TTL_SECONDS = 60;

function bucket() {
  return supabaseAdmin.storage.from(PRODUCT_IMAGE_BUCKET);
}

const supabaseStorage: ProductImageStorage = {
  async createUpload(path) {
    const { data, error } = await bucket().createSignedUploadUrl(path);
    if (error || !data) throw new Error("createSignedUploadUrl failed");
    return { signedUrl: data.signedUrl, path };
  },

  async createReadUrls(paths, expiresInSeconds) {
    const out = new Map<string, string>();
    if (paths.length === 0) return out;
    const { data, error } = await bucket().createSignedUrls(paths, expiresInSeconds);
    if (error || !data) throw new Error("createSignedUrls failed");
    for (const entry of data) {
      if (entry.path && entry.signedUrl && !entry.error) out.set(entry.path, entry.signedUrl);
    }
    return out;
  },

  async inspect(path) {
    const { data, error } = await bucket().createSignedUrl(path, INSPECT_TTL_SECONDS);
    if (error || !data) return null;

    // A ranged GET returns the first bytes AND the total size (Content-Range),
    // so one request proves existence, size and real format without pulling the
    // whole object into the server.
    const res = await fetch(data.signedUrl, {
      headers: { Range: `bytes=0-${PRODUCT_IMAGE_SNIFF_BYTES - 1}` },
    });
    if (res.status === 404 || res.status === 400) return null;
    if (res.status !== 200 && res.status !== 206) throw new Error("inspect failed");

    const contentRange = res.headers.get("content-range");
    const total = contentRange?.match(/\/(\d+)$/)?.[1] ?? res.headers.get("content-length");
    const sizeBytes = total ? Number.parseInt(total, 10) : Number.NaN;

    // Read only the leading bytes; never buffer an oversize object.
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    while (reader && got < PRODUCT_IMAGE_SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      got += value.length;
    }
    await reader?.cancel().catch(() => undefined);

    const head = new Uint8Array(Math.min(got, PRODUCT_IMAGE_SNIFF_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, head.length - offset);
      head.set(chunk.subarray(0, take), offset);
      offset += take;
      if (offset >= head.length) break;
    }
    if (!Number.isFinite(sizeBytes)) throw new Error("inspect: unknown size");
    return { sizeBytes, head };
  },

  async remove(paths) {
    if (paths.length === 0) return;
    const { error } = await bucket().remove(paths);
    if (error) throw new Error("storage remove failed");
  },
};

let storage: ProductImageStorage = supabaseStorage;

export function getProductImageStorage(): ProductImageStorage {
  return storage;
}

/** Test-only override so the domain contract runs without hosted credentials. */
export function setProductImageStorageForTests(testStorage: ProductImageStorage): () => void {
  const previous = storage;
  storage = testStorage;
  return () => {
    storage = previous;
  };
}
