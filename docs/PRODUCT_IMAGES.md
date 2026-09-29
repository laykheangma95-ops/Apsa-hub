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

## Flow

1. `requestProductImageUploadFn` — requires `products.update_basic`; checks the
   declared type/size; verifies the product is in the caller's organization;
   generates the object path server-side; returns a signed upload URL bound to it.
2. Browser downscales (longest edge 1600 px), then PUTs straight to that URL.
3. `attachProductImageFn` — requires `products.update_basic`; path must match the
   exact owned shape for this org + product; server reads the first bytes and the
   size of the stored object (magic-number sniff, size limit); only then points
   the product at it; then deletes the previous object (best-effort).
4. `removeProductImageFn` — requires `products.update_basic`; clears the
   reference first, then deletes the object (best-effort).

Reads: `products.read` callers receive `imageUrl`, a 1-hour signed URL. The
storage path is never returned. A signing failure yields `imageUrl: null`
(placeholder), never a failed catalog load.

## Failure model

| Failure | Result |
|---|---|
| Upload interrupted / never lands | `attach` is not reached (or refused); old image untouched |
| New object corrupt / wrong bytes / oversize | refused, stray object deleted, old image untouched |
| DB save fails after upload | old image untouched; new object deleted |
| Old-object delete fails | orphan object; product row is correct |
| Remove: DB fails | image and object kept |

## Orphan cleanup

Orphans are unreferenced objects (failed best-effort deletes, or an upload the
user abandoned before `attach`). Sweep from a trusted context (staging first):

```sql
SELECT o.name
FROM storage.objects o
LEFT JOIN public.products p ON p.image_path = o.name
WHERE o.bucket_id = 'product-images'
  AND p.id IS NULL
  AND o.created_at < now() - interval '1 day';
```

Review the list, then delete through the Storage API. Automating this is future work.

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
- Two concurrent replaces of the same product can orphan one object (documented above).

## Pending staging QA (needs hosted credentials)

Apply 048 to staging, then verify: bucket exists and is private with the limits;
signed upload/read URLs work and expire; a cross-tenant path cannot be read or
written; real upload/replace/remove lifecycle; Range request on a signed URL
returns `Content-Range` (used by the attach verification); orphan sweep query.
