# Product Images (V1)

One primary photo per Product. Presentation/catalog metadata only — it never
affects price, SKU, barcode, inventory, orders, payments, delivery, labels or
shipping snapshots. Product identity is always `product.id` / `variant.id`,
never an image URL or filename.

## Schema / storage (migration `048_product_images.sql`, repo-only)

- `products.image_path` (nullable) + `image_updated_at`.
- CHECK `products_image_path_owned`: the path must be
  `<this row's organization_id>/<this row's id>/<uuid>.<jpg|png|webp>`. Even a
  service-role write cannot attach another tenant's object.
- Unique index: one object is never shared by two products.
- Private bucket `product-images`, 5 MiB, `image/jpeg | image/png | image/webp`.
  No SVG, HTML or executables. No storage policies are added for
  `anon`/`authenticated`, so browsers have no direct read or write access.
- A future gallery would add a `product_images` table; nothing here blocks it.

## Upload tickets + abuse bounds (migration `049_product_image_uploads.sql`, repo-only)

A signed upload URL is cost-bearing write authority (up to 5 MiB), so issuing
one is bounded and recorded.

- **Ticket table** `product_image_uploads`: one row per issued URL (org, product,
  issuing member, exact object path, `expires_at`). RLS on, no policies, no
  client grants, no SECURITY DEFINER; org/member are set by the server from the
  verified session. The row is written *before* the URL is signed.
- **Attach requires a live ticket** for exactly that org + product + path, and
  consumes (deletes) it once the product references the object.
- **Issuance rate limits** (durable, PostgreSQL `consume_rate_limit`, migration
  045; see `src/server/rate-limit/policies.ts`): 60 per member per hour and 200
  per organization per hour — one per minute per member for an hour, several
  staff at once. The organization bucket stops many staff bypassing the member
  bucket. Buckets are scoped by the server-verified org/user; another
  organization is unaffected.
- **Outstanding-ticket caps**: 30 unattached tickets per member, 100 per
  organization (≤ 500 MiB worst case per org). Under concurrency the cap can be
  overshot by the number of simultaneous requests, which the rate limit bounds.
- **Limiter unavailable ⇒ FAIL CLOSED** (`BACKEND_FAILURE_POLICY.productImageUpload`):
  the request gets a retryable 503 and no ticket or URL is issued. A per-instance
  memory fallback would multiply the limit by the instance count exactly when the
  database is struggling, and photos are optional, so a short outage costs a
  retry, not a sale.

## Abandoned-upload cleanup

- Ticket TTL is 3 h; Supabase signs an upload URL for 2 h, so once a ticket is
  expired no upload can still land.
- Every ticket request first sweeps expired tickets: oldest first, **at most 25
  per call**, across tenants (server housekeeping; nothing is returned). An
  object is deleted only if its ticket is expired, its path has exactly its own
  ticket's org/product shape, and **no product references it** — a current image
  is never removed, even if a ticket row was left behind. The row is deleted
  after the object; a failed storage delete keeps the row for the next sweep.
- A sweep failure never blocks ticket issuance or any read. Cross-tenant
  sweeping is deliberate: a per-org sweep would leave a dormant organization's
  abandoned uploads forever.
- Rejected uploads (spoofed/truncated/oversize) are deleted with their ticket
  immediately. The failure modes that remain are bounded by the caps above and
  cleared by the next sweep.

## Flow

1. `requestProductImageUploadFn` — requires `products.update_basic`; checks the
   declared type/size; rate-limits (member + organization, fail closed); verifies
   the product is in the caller's organization; sweeps expired tickets; enforces
   the outstanding caps; records a ticket; generates the object path
   server-side; returns a signed upload URL bound to it.
2. Browser downscales (longest edge 1600 px), then PUTs straight to that URL.
3. `attachProductImageFn` — requires `products.update_basic`; path must match the
   exact owned shape for this org + product and have a live ticket; the server
   reads a bounded leading probe and the verified total size of the stored
   object (see below); only then points the product at it, consumes the ticket,
   and deletes the previous object (best-effort).
4. `removeProductImageFn` — requires `products.update_basic`; clears the
   reference first, then deletes the object (best-effort).

Reads: `products.read` callers receive `imageUrl`, a 1-hour signed URL.

Storage path exposure, stated precisely: `image_path` is not returned as a
separate API field, and clients receive only a temporary signed bearer URL. That
URL may itself contain the bucket and object path. The path is not an authorization secret —
access is granted by the signed token, which is temporary — and it embeds only
UUIDs, never a filename. APSA does not proxy
images just to hide the path. A signing failure yields `imageUrl: null`
(placeholder), never a failed catalog load.

## Server-side verification of the stored object

- **Size** comes only from a source describing the whole object. The server
  sends `Range: bytes=0-131071`. On **206**, `Content-Range` is required and
  strictly parsed (`bytes 0-N/TOTAL`; a missing, malformed, `*`/unknown-total or
  contradictory value — start ≠ 0, end ≥ total, not the requested range clamped
  to the object, `Content-Length` ≠ range length, short body — is refused). A
  206's `Content-Length` is never used as the object size. On **200** (Range
  ignored) `Content-Length` is the size, and a missing/invalid length or a
  `Content-Encoding` is refused. 404/400/416 mean "no usable object"; every other
  status, and every ambiguity, fails closed (retryable 503). Over 5 MiB is refused.
- **Structure** (`inspectImageStructure`, bounded to the 128 KiB probe):
  JPEG — SOI, bounded marker walk, a complete frame header (SOF) with sane
  component data, no truncated segment, no scan/EOI before the frame header;
  PNG — signature, an IHDR of length 13 with a valid CRC, valid bit-depth/colour
  combination; WebP — RIFF/WEBP whose declared length does not exceed the object,
  well-formed chunks, and a real `VP8 `/`VP8L` payload (`VP8X` alone is not
  enough; animated WebP is refused). A JPEG whose frame header is not reached
  inside the probe is refused. This is structural, not a decode.
- **Dimensions**: width and height ≥ 1, ≤ 8192 px per edge and ≤ 40 megapixels.
  Honest uploads are ≤ 1600 px (the browser downscales), so the bound only stops
  small files that decode to enormous bitmaps and protects low-memory phones; a
  12 MP phone photo passes.
- The detected format must equal the format in the (server-generated) path.

## Failure model

| Failure | Result |
|---|---|
| Upload interrupted / never lands | `attach` is not reached (or refused); old image untouched |
| New object corrupt / wrong bytes / oversize | refused, stray object deleted, old image untouched |
| DB save fails after upload | old image untouched; new object deleted |
| Old-object delete fails | orphan object; product row is correct |
| Remove: DB fails | image and object kept |

## Remaining orphans

Upload orphans are bounded and swept (above). Two rarer sources remain: an old
object whose best-effort delete failed after a replace/remove, and concurrent
replaces of one product. Neither is ticketed. Sweep them from a trusted context
(staging first): list objects in `product-images` whose name is not any
`products.image_path` and not in `product_image_uploads.object_path`, review, and
delete through the Storage API.

## Performance

No image-transformation service exists. V1 keeps it simple: client-side downscale
before upload, `loading="lazy"`, `decoding="async"`, fixed square boxes (no layout
shift) with `object-cover`. Future: server-generated thumbnails
(e.g. 96/320 px variants at attach time, or Supabase image transformations) so
list rows never load the 1600 px original.

## Known limits (V1)

- HEIC/HEIF is refused with a clear message (no reliable decode path).
- Signed read URLs expire after 1 hour; a screen left open longer falls back to
  the placeholder until the next refetch.
- Two concurrent replaces of the same product can orphan one object (see Remaining orphans).
- A JPEG with more than ~128 KiB of metadata before its frame header is refused.

## Pending staging QA (needs hosted credentials — NOT done)

Apply 048 then 049 to staging, then verify: bucket exists and is private with
the limits; signed upload/read URLs work and expire; a cross-tenant path cannot
be read or written; real upload/replace/remove lifecycle; the **Range request
on a signed URL** — the exact status (200 vs 206), `Content-Range` behaviour and
any CDN/proxy rewriting (the code fails closed on anything unexpected but has
only been tested against fake responses, so hosted compatibility is unproven);
signed-upload token expiry against the 3 h ticket TTL; real expired-ticket
cleanup (objects actually removed); durable rate-limit behaviour across
instances; cross-tenant storage attempts.

## Pending device QA (manual)

iPhone and Android camera capture; HEIC rejection; image orientation;
low-memory behaviour; 320/360/390/430 px layouts; slow/interrupted upload.
