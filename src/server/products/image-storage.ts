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
import { PRODUCT_IMAGE_BUCKET, PRODUCT_IMAGE_PROBE_BYTES } from "@/lib/product-image";

export interface SignedUpload {
  /** Full signed PUT URL (contains a one-path, short-lived token). */
  signedUrl: string;
  path: string;
}

export interface ObjectInspection {
  /** Total object size in bytes. */
  sizeBytes: number;
  /** Leading bytes (up to PRODUCT_IMAGE_PROBE_BYTES) for structural validation. */
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

/**
 * Turn a ranged-GET response into a verified {size, head}, or fail closed.
 *
 * The total object size is only ever taken from a source that describes the
 * WHOLE object: Content-Range's `/total` on a 206, or Content-Length on a 200
 * (the server ignored Range and is sending the whole body). A 206's
 * Content-Length is the length of the partial body and is never used as the
 * object size. Anything ambiguous throws (the service maps that to a
 * retryable 503) — it is never guessed.
 *
 * Returns null when the object is absent or empty (404 / 400 / 416).
 */
export async function evaluateProbeResponse(res: Response): Promise<ObjectInspection | null> {
  const cancel = () => res.body?.cancel().catch(() => undefined);
  const wanted = PRODUCT_IMAGE_PROBE_BYTES;
  if (res.status === 404 || res.status === 400 || res.status === 416) {
    await cancel();
    return null;
  }

  let sizeBytes: number;
  let expectedBody: number; // exact number of bytes the probe must contain
  const contentLength = strictInt(res.headers.get("content-length"));

  if (res.status === 206) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
    if (!m) {
      await cancel();
      throw new Error("inspect: missing or malformed Content-Range");
    }
    const start = Number(m[1]);
    const end = Number(m[2]);
    const total = Number(m[3]);
    const valid =
      Number.isSafeInteger(total) &&
      total > 0 &&
      start === 0 &&
      end >= start &&
      end < total &&
      // The server must return exactly the range asked for, clamped to the object.
      end === Math.min(wanted, total) - 1 &&
      (contentLength === null || contentLength === end - start + 1);
    if (!valid) {
      await cancel();
      throw new Error("inspect: contradictory Content-Range");
    }
    sizeBytes = total;
    expectedBody = end - start + 1;
  } else if (res.status === 200) {
    // Range ignored: the body is the whole object and Content-Length is its size.
    const encoding = res.headers.get("content-encoding");
    if (contentLength === null || (encoding && encoding.toLowerCase() !== "identity")) {
      await cancel();
      throw new Error("inspect: unknown object size");
    }
    sizeBytes = contentLength;
    expectedBody = Math.min(wanted, sizeBytes);
  } else {
    await cancel();
    throw new Error("inspect failed");
  }

  // Read only the leading bytes; never buffer an oversize object.
  const reader = res.body?.getReader();
  const head = new Uint8Array(expectedBody);
  let got = 0;
  while (reader && got < expectedBody) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const take = Math.min(value.length, expectedBody - got);
    head.set(value.subarray(0, take), got);
    got += take;
  }
  await reader?.cancel().catch(() => undefined);
  // A body shorter than the metadata promised is not proof of anything.
  if (got !== expectedBody) throw new Error("inspect: short body");
  return { sizeBytes, head };
}

function strictInt(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
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

    // A ranged GET returns the leading bytes AND (via Content-Range) the total
    // size, so one request proves existence, size and structure without
    // pulling the whole object into the server.
    const res = await fetch(data.signedUrl, {
      headers: { Range: `bytes=0-${PRODUCT_IMAGE_PROBE_BYTES - 1}` },
    });
    return evaluateProbeResponse(res);
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
