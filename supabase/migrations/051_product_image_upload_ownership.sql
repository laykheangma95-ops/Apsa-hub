-- Migration: 051_product_image_upload_ownership
-- Purpose: lease OWNERSHIP for the signed-upload ticket lifecycle (follow-up to 050).
--   050 let any caller that knew (org, product, path) release or finalize a
--   'claimed' row and any sweep delete a 'cleaning' row, so a stale owner whose
--   lease lapsed could act on a newer owner's row. Authority is now a
--   server-generated token that changes on every acquisition and is matched on
--   every later transition. Correctness never depends on timing.
-- Repo-only: NOT applied to any hosted project by this change.
--
-- Attach ownership
--   claim_token    fresh gen_random_uuid() on EVERY successful claim (including a
--                  re-claim after a lapsed claim). Returned to the claimer.
--   release / resolve / finalize succeed only with state='claimed' AND
--   claim_token = caller's token AND matching org/product/path. A stale owner's
--   token matches nothing once another attach re-claimed, or a sweep took, the
--   row, so it cannot release, resolve or finalize.
--   claim_expires_at is only the recovery window (when another attach or a sweep
--   MAY take over); it is not consulted by finalize. A claim that was valid when
--   acquired may therefore finish even if the ticket's own expires_at passes
--   meanwhile, provided nobody took the row over.
-- Cleanup ownership
--   cleanup_token  fresh gen_random_uuid() every time a sweep takes a row (state
--                  -> cleaning; cleanup_retry_after is the lease). Resolve and
--                  failure-recording require state='cleaning' AND the token; a
--                  failure clears the token (ownership released, backoff runs).
-- Access model: unchanged (RLS on, nothing granted to anon/authenticated). All
-- functions SECURITY INVOKER, search_path pinned, EXECUTE for service_role only.

ALTER TABLE public.product_image_uploads
  ADD COLUMN claim_token   UUID,
  ADD COLUMN cleanup_token UUID;

-- Rows from 050 that are mid-flight get a token so the new shape holds; every
-- other row keeps NULL tokens.
UPDATE public.product_image_uploads SET claim_token = gen_random_uuid() WHERE state = 'claimed';
UPDATE public.product_image_uploads SET cleanup_token = gen_random_uuid() WHERE state = 'cleaning';

ALTER TABLE public.product_image_uploads
  ADD CONSTRAINT product_image_uploads_claim_token_shape
    CHECK ((state = 'claimed') = (claim_token IS NOT NULL)),
  ADD CONSTRAINT product_image_uploads_cleanup_token_shape
    CHECK (cleanup_token IS NULL OR state = 'cleaning');

DROP FUNCTION public.finalize_product_image_upload_v1(UUID, UUID, TEXT);
DROP FUNCTION public.take_product_image_upload_cleanup_v1(INTEGER, INTEGER);
DROP FUNCTION public.fail_product_image_upload_cleanup_v1(UUID[]);

-- ── Claim: returns the new ownership token, or NULL (fail closed) ────────────
CREATE OR REPLACE FUNCTION public.claim_product_image_upload_v1(
  p_org            UUID,
  p_product        UUID,
  p_path           TEXT,
  p_claim_seconds  INTEGER
) RETURNS UUID
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  UPDATE public.product_image_uploads
     SET state = 'claimed',
         claim_token = gen_random_uuid(),
         claimed_at = now(),
         claim_expires_at = now() + make_interval(secs => p_claim_seconds)
   WHERE organization_id = p_org
     AND product_id = p_product
     AND object_path = p_path
     AND expires_at > now()
     AND (state = 'pending' OR (state = 'claimed' AND claim_expires_at <= now()))
  RETURNING claim_token;
$$;

-- ── Owned release: claimed -> pending, only for the current claim ────────────
CREATE FUNCTION public.release_product_image_upload_claim_v1(
  p_org     UUID,
  p_product UUID,
  p_path    TEXT,
  p_token   UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  UPDATE public.product_image_uploads
     SET state = 'pending', claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL
   WHERE organization_id = p_org AND product_id = p_product AND object_path = p_path
     AND state = 'claimed' AND claim_token = p_token
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- ── Owned resolve: delete the ticket of a rejected upload (current claim only)
CREATE FUNCTION public.resolve_product_image_upload_claim_v1(
  p_org     UUID,
  p_product UUID,
  p_path    TEXT,
  p_token   UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  DELETE FROM public.product_image_uploads
   WHERE organization_id = p_org AND product_id = p_product AND object_path = p_path
     AND state = 'claimed' AND claim_token = p_token
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- ── Owned finalize: claimed -> consumed AND product updated, one transaction ─
-- Returns the product's previous image path ('' when none) or NULL when the
-- caller does not own the current claim (nothing changed).
CREATE FUNCTION public.finalize_product_image_upload_v1(
  p_org     UUID,
  p_product UUID,
  p_path    TEXT,
  p_token   UUID
) RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id   UUID;
  v_prev TEXT;
BEGIN
  UPDATE public.product_image_uploads
     SET state = 'consumed', consumed_at = now(),
         claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL
   WHERE organization_id = p_org AND product_id = p_product AND object_path = p_path
     AND state = 'claimed' AND claim_token = p_token
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN NULL; END IF;

  SELECT image_path INTO v_prev FROM public.products
   WHERE id = p_product AND organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.products SET image_path = p_path, image_updated_at = now()
   WHERE id = p_product AND organization_id = p_org;
  RETURN coalesce(v_prev, '');
END;
$$;

-- ── Cleanup: take a bounded batch, assigning a fresh cleanup token per row ───
CREATE FUNCTION public.take_product_image_upload_cleanup_v1(
  p_limit         INTEGER,
  p_lease_seconds INTEGER
) RETURNS TABLE (
  id UUID, organization_id UUID, product_id UUID, object_path TEXT, cleanup_token UUID
)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids UUID[];
BEGIN
  SELECT array_agg(c.id) INTO v_ids FROM (
    SELECT u.id FROM public.product_image_uploads u
     WHERE u.expires_at <= now()
       AND (u.state = 'pending'
         OR (u.state = 'claimed' AND u.claim_expires_at <= now())
         OR (u.state = 'cleaning' AND u.cleanup_retry_after <= now()))
     ORDER BY u.cleanup_error_count ASC, u.expires_at ASC
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  ) c;

  IF v_ids IS NOT NULL THEN
    UPDATE public.product_image_uploads u
       SET state = 'consumed', consumed_at = now(),
           claim_token = NULL, cleanup_token = NULL,
           claimed_at = NULL, claim_expires_at = NULL, cleanup_retry_after = NULL
     WHERE u.id = ANY (v_ids)
       AND EXISTS (SELECT 1 FROM public.products p WHERE p.image_path = u.object_path);

    -- Taking a row (from pending, a lapsed claim, or another sweep's lapsed
    -- lease) revokes every earlier owner: their tokens no longer match.
    RETURN QUERY
    WITH taken AS (
      UPDATE public.product_image_uploads u
         SET state = 'cleaning',
             cleanup_token = gen_random_uuid(),
             claim_token = NULL,
             cleanup_attempted_at = now(),
             cleanup_retry_after = now() + make_interval(secs => p_lease_seconds),
             claimed_at = NULL, claim_expires_at = NULL
       WHERE u.id = ANY (v_ids) AND u.state <> 'consumed'
      RETURNING u.id, u.organization_id, u.product_id, u.object_path, u.cleanup_token
    )
    SELECT t.id, t.organization_id, t.product_id, t.object_path, t.cleanup_token FROM taken t;
  END IF;

  DELETE FROM public.product_image_uploads d
   WHERE d.id IN (
     SELECT x.id FROM public.product_image_uploads x
      WHERE x.state = 'consumed' AND x.consumed_at < now() - interval '1 day'
      LIMIT p_limit);
END;
$$;

-- ── Owned cleanup resolution: delete rows whose (id, token) pair is current ──
-- Returns the ids actually resolved; a stale sweep's pairs match nothing.
CREATE FUNCTION public.resolve_product_image_upload_cleanup_v1(p_ids UUID[], p_tokens UUID[])
RETURNS UUID[]
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  WITH done AS (
    DELETE FROM public.product_image_uploads u
     USING unnest(p_ids, p_tokens) AS o(id, token)
     WHERE u.id = o.id AND u.state = 'cleaning' AND u.cleanup_token = o.token
    RETURNING u.id
  )
  SELECT coalesce(array_agg(id), ARRAY[]::UUID[]) FROM done;
$$;

-- ── Owned failure: backoff + count, releases ownership ───────────────────────
-- Returns ids whose error count reached p_alert_threshold on THIS failure (the
-- operator signal: logged once per crossing, safe identifiers only).
CREATE FUNCTION public.fail_product_image_upload_cleanup_v1(
  p_ids             UUID[],
  p_tokens          UUID[],
  p_alert_threshold INTEGER
) RETURNS UUID[]
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  WITH failed AS (
    UPDATE public.product_image_uploads u
       SET cleanup_error_count = u.cleanup_error_count + 1,
           cleanup_token = NULL,
           cleanup_retry_after = now() + LEAST(
             interval '6 hours',
             interval '5 minutes' * power(2, LEAST(u.cleanup_error_count, 6)))
      FROM unnest(p_ids, p_tokens) AS o(id, token)
     WHERE u.id = o.id AND u.state = 'cleaning' AND u.cleanup_token = o.token
    RETURNING u.id, u.cleanup_error_count
  )
  SELECT coalesce(array_agg(id) FILTER (WHERE cleanup_error_count = p_alert_threshold),
                  ARRAY[]::UUID[])
    FROM failed;
$$;

REVOKE EXECUTE ON FUNCTION
  public.claim_product_image_upload_v1(UUID, UUID, TEXT, INTEGER),
  public.release_product_image_upload_claim_v1(UUID, UUID, TEXT, UUID),
  public.resolve_product_image_upload_claim_v1(UUID, UUID, TEXT, UUID),
  public.finalize_product_image_upload_v1(UUID, UUID, TEXT, UUID),
  public.take_product_image_upload_cleanup_v1(INTEGER, INTEGER),
  public.resolve_product_image_upload_cleanup_v1(UUID[], UUID[]),
  public.fail_product_image_upload_cleanup_v1(UUID[], UUID[], INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.claim_product_image_upload_v1(UUID, UUID, TEXT, INTEGER),
  public.release_product_image_upload_claim_v1(UUID, UUID, TEXT, UUID),
  public.resolve_product_image_upload_claim_v1(UUID, UUID, TEXT, UUID),
  public.finalize_product_image_upload_v1(UUID, UUID, TEXT, UUID),
  public.take_product_image_upload_cleanup_v1(INTEGER, INTEGER),
  public.resolve_product_image_upload_cleanup_v1(UUID[], UUID[]),
  public.fail_product_image_upload_cleanup_v1(UUID[], UUID[], INTEGER)
  TO service_role;
