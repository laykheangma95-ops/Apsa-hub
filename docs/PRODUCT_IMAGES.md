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

## Upload tickets + abuse bounds (migrations `049` + `050` + `051`, repo-only)

A signed upload URL is cost-bearing write authority (up to 5 MiB), so issuing
one is bounded and recorded.

- **Ticket table** `product_image_uploads`: one row per issued URL (org, product,
  issuing member, exact object path, `expires_at`, `state`). RLS on, no policies,
  no client grants; org/member are set by the server from the verified session.
  The row is written _before_ the URL is signed.
- **Issuance rate limits** (durable, PostgreSQL `consume_rate_limit`, migration
  045; see `src/server/rate-limit/policies.ts`): 60 per member per hour and 200
  per organization per hour. These are burst limits; they are **not** a
  substitute for the backlog caps below.
- **Limiter unavailable ⇒ FAIL CLOSED** (`BACKEND_FAILURE_POLICY.productImageUpload`):
  retryable 503, no ticket, no URL.

### Ticket lifecycle (migration 050)

| state      | meaning                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------- |
| `pending`  | issued, nobody is attaching it; live until `expires_at`                                   |
| `claimed`  | ONE attach owns it; protected from cleanup until `claim_expires_at` (120 s)               |
| `consumed` | the product references the object; never reusable, never cleaned (row pruned after 1 day) |
| `cleaning` | a sweep owns it and is deleting the object; `cleanup_retry_after` is the lease / backoff  |

All transitions are single database functions (SECURITY INVOKER, pinned
`search_path`, `EXECUTE` for `service_role` only):

- **Issue** `issue_product_image_upload_v1`: takes an organization-scoped
  advisory transaction lock, counts the member's and the organization's
  unresolved tickets, and inserts — one transaction, so 40 simultaneous requests
  cannot create more than 30 tickets (member) or 100 (organization). The server
  signs a URL only when it returns `ok`.
- **Claim** `claim_product_image_upload_v1`: one `UPDATE … WHERE state='pending'
AND expires_at > now() AND org/product/path match RETURNING`. No row ⇒ fail
  closed. Two racing attaches: exactly one claims. The claim happens before any
  storage inspection or product change.
- **Finalize** `finalize_product_image_upload_v1`: ticket `claimed → consumed`
  **and** `products.image_path = object` in one transaction, returning the
  previous path for the best-effort delete. A product is never updated with its
  ticket left unconsumed, or the reverse.
- **Backlog caps** count every _unresolved_ ticket — `pending` (live **or
  expired but not yet cleaned**), `claimed`, `cleaning` — 30 per member, 100 per
  organization. Expiry does not remove a ticket from the count; only a real
  successful delete (or consumption) does. A storage delete that fails forever
  therefore ends in fail-closed issuance instead of unbounded storage growth.

### Claim recovery

A crashed attach leaves a `claimed` ticket. It cannot get stuck: after
`claim_expires_at` the ticket is claimable again while live, and cleanable once
also expired. An _active_ claim is never cleaned, even after the ticket's own
expiry (the attach-vs-sweep race). If a slow attach's claim lapsed and the
sweep took the ticket, its `finalize` returns nothing and the product is left
untouched — it can never point at an object the sweep deleted.

Failure before the product changed: invalid/spoofed content → object deleted,
ticket resolved; transient failure (storage inspect, finalize) → claim released
(retryable), object kept. Once finalized the object is never deleted by attach.

### Lease ownership (migration 051)

Authority over a ticket row is a **server-generated token**, never timing.

- **Claim token.** Every successful `claim_product_image_upload_v1` (including a
  re-claim after a lapsed claim) sets a fresh `claim_token` and returns it. The
  attach flow carries it through every later step. `release_…_claim_v1`,
  `resolve_…_claim_v1` and `finalize_product_image_upload_v1` succeed only for
  `state='claimed' AND claim_token = <caller's token>` with matching
  org/product/path; otherwise they change nothing. A stale attach can therefore
  never release, resolve or finalize a newer attach's claim, and a duplicate
  stale finalize fails safely. Finalize (ticket → `consumed` + product update)
  is still one transaction.
- **Cleanup token.** Every time a sweep takes a row (from `pending`, a lapsed
  claim, or another sweep's lapsed lease) it gets a fresh `cleanup_token`
  (`cleanup_retry_after` is the lease). `resolve_…_cleanup_v1` and
  `fail_…_cleanup_v1` take `(id, token)` pairs and act only on rows still
  `cleaning` with that exact token, per row. A failure records the backoff and
  clears the token (ownership released). A sweep that lost its lease resolves or
  fails nothing.
- Tokens are NULL on every row that is not currently claimed / cleaning, and are
  never returned to a browser, logged, or included in an error.

**Expiry vs. ownership.** Ticket expiry (`expires_at`) governs whether a ticket
can be _claimed_ or is _eligible for cleanup_. Once a claim is held, it may
continue through its lease window (`claim_expires_at`, 120 s) even if the
ticket's `expires_at` passes meanwhile: finalize checks the claim token, not the
clock. After the lease lapses another attach may re-claim (live ticket) or a
sweep may take the row (expired ticket); either revokes the old token. So a
stale owner loses authority by token mismatch, and an untaken lapsed claim can
still finish — it is the takeover, not the clock, that ends ownership.

### Operator visibility and manual procedure

- When one ticket's `cleanup_error_count` reaches
  `PRODUCT_IMAGE_CLEANUP_ALERT_THRESHOLD` (5) the sweep logs a single
  `product_image.cleanup_persistent_failure` warning with the ticket ids and the
  threshold. Ticket ids only — never paths, signed URLs or tokens.
- Manual inspection (service role, staging/prod SQL): `select id, organization_id,
product_id, cleanup_error_count, cleanup_attempted_at, cleanup_retry_after from
product_image_uploads where state = 'cleaning' and cleanup_error_count >= 5;`.
  Find the storage object via the row's `object_path`, confirm no product
  references it (`products.image_path`), delete it in the storage console, then
  delete the ticket row. Never delete an object a product references.
- **No scheduler.** Cleanup remains issuance-triggered (each ticket request
  sweeps a bounded batch). A tenant that stops uploading stops sweeping;
  staging/ops should verify whether a scheduled maintenance sweep is needed
  before production. Not added here.

## Abandoned-upload cleanup

- Ticket TTL is 3 h; Supabase signs an upload URL for 2 h, so once a ticket is
  expired no upload can still land.
- Every ticket request first sweeps: `take_product_image_upload_cleanup_v1`
  row-locks (`FOR UPDATE SKIP LOCKED`) **at most 25** eligible tickets (expired
  and not under an active claim) across tenants and marks them `cleaning`.
  A row whose object some product references is resolved as `consumed`, never
  returned for deletion; the server additionally re-checks `products.image_path`
  and the path's org/product shape before every delete. **The product reference
  is authoritative.**
- Each row is deleted independently. A failure keeps that row unresolved (still
  counted) with exponential backoff (5 min … 6 h) and an error count; selection
  is ordered by fewest failures first, so undeletable rows cannot starve later
  ones. A sweep failure never blocks issuance or reads.
- Cross-tenant sweeping is internal only; nothing from the rows reaches a client.

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

| Failure                                     | Result                                                             |
| ------------------------------------------- | ------------------------------------------------------------------ |
| Upload interrupted / never lands            | `attach` is not reached (or refused); old image untouched          |
| New object corrupt / wrong bytes / oversize | refused, stray object deleted, old image untouched                 |
| DB save fails after upload                  | old image untouched; claim released, object kept, attach retryable |
| Old-object delete fails                     | orphan object; product row is correct                              |
| Remove: DB fails                            | image and object kept                                              |

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

Apply 048, 049, 050 then 051 to staging, then verify: bucket exists and is private with
the limits; signed upload/read URLs work and expire; a cross-tenant path cannot
be read or written; real upload/replace/remove lifecycle; the **Range request
on a signed URL** — the exact status (200 vs 206), `Content-Range` behaviour and
any CDN/proxy rewriting (the code fails closed on anything unexpected but has
only been tested against fake responses, so hosted compatibility is unproven);
signed-upload token expiry against the 3 h ticket TTL; real expired-ticket
cleanup (objects actually removed); durable rate-limit behaviour across
instances; **concurrent issuance/claim under real multi-connection Postgres** (the
local tests run on single-connection PGlite); cross-tenant storage attempts.

## Pending device QA (manual)

iPhone and Android camera capture; HEIC rejection; image orientation;
low-memory behaviour; 320/360/390/430 px layouts; slow/interrupted upload.
