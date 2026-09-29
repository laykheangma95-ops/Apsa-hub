-- Migration: 050_product_image_upload_lifecycle
-- Purpose: make the signed-upload ticket lifecycle atomic (follow-up to 049):
--   1. attach vs cleanup race      -> explicit ticket state + atomic claim/finalize
--   2. unbounded abandoned storage -> caps count UNRESOLVED tickets, expired or not
--   3. non-atomic issuance caps    -> count + insert under one org-scoped lock
-- Repo-only: NOT applied to any hosted project by this change. Apply through the
-- normal reviewed staging -> production path, after 049.
-- Touches: public.product_image_uploads (columns/indexes added), five new functions.
--
-- Ticket states
--   pending   issued; nobody is attaching it. Live until expires_at.
--   claimed   ONE attach flow owns it. Protected from cleanup while
--             claim_expires_at is in the future (a short window, so a crashed
--             attach cannot leave the ticket stuck).
--   consumed  the product now references the object; never reusable, never
--             cleaned. Rows are pruned after a day (path uniqueness only needs
--             them while a replay is plausible).
--   cleaning  a sweep owns it and is deleting the object; cleanup_retry_after is
--             the lease (a crashed sweep is retried) and, after a failed delete,
--             the backoff that lets later rows advance past a stuck one.
-- "Unresolved" = pending + claimed + cleaning. Every unresolved row counts
-- toward the issuance caps whether or not expires_at has passed, so a storage
-- delete that fails forever eventually stops new upload authority instead of
-- letting abandoned objects accumulate.
--
-- Atomicity
--   * issue_product_image_upload_v1: pg_advisory_xact_lock(organization) then
--     count member, count organization, insert. One transaction; concurrent
--     issuances for an organization are serialized, so the caps cannot be raced.
--   * claim_product_image_upload_v1: one UPDATE ... WHERE state/expiry/org/
--     product/path ... RETURNING. No row -> fail closed. Two racing attaches:
--     exactly one gets the row.
--   * finalize_product_image_upload_v1: ticket claimed->consumed AND the product
--     row pointing at the object, in ONE transaction. A product can never be
--     updated while its ticket is left unconsumed (or the reverse).
--   * take_product_image_upload_cleanup_v1: row-locked (FOR UPDATE SKIP LOCKED)
--     selection of eligible rows; a row whose object a product references is
--     marked consumed, never handed out for deletion. Cleanup and finalize both
--     need the row's state, so they cannot both win.
-- The product reference stays authoritative: nothing here ever deletes an
-- object; the server deletes only what take_... handed out.
--
-- Access model: unchanged from 049 (RLS enabled, no policies, nothing granted to
-- anon/authenticated). The functions are SECURITY INVOKER (default) with
-- search_path pinned, and EXECUTE only for service_role; no privilege is
-- escalated, so no SECURITY DEFINER is introduced. organization_id / issued_by
-- still come from the verified server session, never from a client.

ALTER TABLE public.product_image_uploads
  ADD COLUMN state               TEXT        NOT NULL DEFAULT 'pending',
  ADD COLUMN claimed_at          TIMESTAMPTZ,
  ADD COLUMN claim_expires_at    TIMESTAMPTZ,
  ADD COLUMN consumed_at         TIMESTAMPTZ,
  ADD COLUMN cleanup_attempted_at TIMESTAMPTZ,
  ADD COLUMN cleanup_error_count INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN cleanup_retry_after TIMESTAMPTZ;

-- Every 049 row is an issued-but-unattached ticket (049 deleted the row on
-- attach), so the 'pending' default is the correct state for existing rows.
ALTER TABLE public.product_image_uploads
  ADD CONSTRAINT product_image_uploads_state_valid
    CHECK (state IN ('pending', 'claimed', 'consumed', 'cleaning')),
  ADD CONSTRAINT product_image_uploads_claim_shape
    CHECK (state <> 'claimed' OR (claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL)),
  ADD CONSTRAINT product_image_uploads_consumed_shape
    CHECK (state <> 'consumed' OR consumed_at IS NOT NULL),
  ADD CONSTRAINT product_image_uploads_cleanup_errors_nonneg
    CHECK (cleanup_error_count >= 0);

DROP INDEX public.product_image_uploads_org_member_idx;
DROP INDEX public.product_image_uploads_expires_idx;

-- Unresolved-backlog counts (member and organization) — issuance caps.
CREATE INDEX product_image_uploads_backlog_idx
  ON public.product_image_uploads(organization_id, issued_by)
  WHERE state <> 'consumed';

-- Cleanup sweep: fewest failures first, then oldest expiry.
CREATE INDEX product_image_uploads_sweep_idx
  ON public.product_image_uploads(cleanup_error_count, expires_at)
  WHERE state <> 'consumed';

-- Claim recovery (stale claims) and consumed-row pruning.
CREATE INDEX product_image_uploads_claim_idx
  ON public.product_image_uploads(claim_expires_at)
  WHERE state = 'claimed';
CREATE INDEX product_image_uploads_consumed_idx
  ON public.product_image_uploads(consumed_at)
  WHERE state = 'consumed';

-- ── Atomic issuance ──────────────────────────────────────────────────────────
-- Returns 'ok' | 'member_cap' | 'org_cap'. Caller signs the URL only on 'ok'.
CREATE FUNCTION public.issue_product_image_upload_v1(
  p_org         UUID,
  p_product     UUID,
  p_user        UUID,
  p_path        TEXT,
  p_ttl_seconds INTEGER,
  p_member_cap  INTEGER,
  p_org_cap     INTEGER
) RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member INTEGER;
  v_org    INTEGER;
BEGIN
  -- One lock per organization covers both caps (a member is inside an org).
  PERFORM pg_advisory_xact_lock(hashtextextended('product_image_uploads:' || p_org::text, 0));

  SELECT count(*) INTO v_member FROM public.product_image_uploads
   WHERE organization_id = p_org AND issued_by = p_user AND state <> 'consumed';
  IF v_member >= p_member_cap THEN RETURN 'member_cap'; END IF;

  SELECT count(*) INTO v_org FROM public.product_image_uploads
   WHERE organization_id = p_org AND state <> 'consumed';
  IF v_org >= p_org_cap THEN RETURN 'org_cap'; END IF;

  INSERT INTO public.product_image_uploads(organization_id, product_id, issued_by, object_path, expires_at)
  VALUES (p_org, p_product, p_user, p_path, now() + make_interval(secs => p_ttl_seconds));
  RETURN 'ok';
END;
$$;

-- ── Atomic claim ─────────────────────────────────────────────────────────────
-- Succeeds only for a live pending ticket (or a claim whose window has lapsed,
-- which is how a crashed attach is recovered) bound to exactly this org +
-- product + path. Returns the ticket id, or NULL (fail closed).
CREATE FUNCTION public.claim_product_image_upload_v1(
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
         claimed_at = now(),
         claim_expires_at = now() + make_interval(secs => p_claim_seconds)
   WHERE organization_id = p_org
     AND product_id = p_product
     AND object_path = p_path
     AND expires_at > now()
     AND (state = 'pending' OR (state = 'claimed' AND claim_expires_at <= now()))
  RETURNING id;
$$;

-- ── Atomic finalize ──────────────────────────────────────────────────────────
-- claimed -> consumed AND product.image_path = object, one transaction.
-- Returns the product's previous image path ('' when it had none) or NULL when
-- the ticket is no longer this flow's to finalize (nothing was changed).
CREATE FUNCTION public.finalize_product_image_upload_v1(
  p_org     UUID,
  p_product UUID,
  p_path    TEXT
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
         claimed_at = NULL, claim_expires_at = NULL
   WHERE organization_id = p_org AND product_id = p_product AND object_path = p_path
     AND state = 'claimed'
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

-- ── Cleanup: take a bounded batch ────────────────────────────────────────────
-- Eligible: ticket expired AND (pending, OR claim lapsed, OR a cleaning lease /
-- backoff that has elapsed). An active claim is never eligible. Fewest failures
-- first so undeletable rows cannot starve later ones. Rows whose object some
-- product references are resolved as consumed instead of returned.
CREATE FUNCTION public.take_product_image_upload_cleanup_v1(
  p_limit         INTEGER,
  p_lease_seconds INTEGER
) RETURNS TABLE (id UUID, organization_id UUID, product_id UUID, object_path TEXT)
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
           claimed_at = NULL, claim_expires_at = NULL, cleanup_retry_after = NULL
     WHERE u.id = ANY (v_ids)
       AND EXISTS (SELECT 1 FROM public.products p WHERE p.image_path = u.object_path);

    RETURN QUERY
    WITH taken AS (
      UPDATE public.product_image_uploads u
         SET state = 'cleaning',
             cleanup_attempted_at = now(),
             cleanup_retry_after = now() + make_interval(secs => p_lease_seconds),
             claimed_at = NULL, claim_expires_at = NULL
       WHERE u.id = ANY (v_ids) AND u.state <> 'consumed'
      RETURNING u.id, u.organization_id, u.product_id, u.object_path
    )
    SELECT t.id, t.organization_id, t.product_id, t.object_path FROM taken t;
  END IF;

  -- Housekeeping: resolved rows are only needed briefly; keep the table small.
  DELETE FROM public.product_image_uploads d
   WHERE d.id IN (
     SELECT x.id FROM public.product_image_uploads x
      WHERE x.state = 'consumed' AND x.consumed_at < now() - interval '1 day'
      LIMIT p_limit);
END;
$$;

-- ── Cleanup: record a failed delete (backoff, count) ─────────────────────────
CREATE FUNCTION public.fail_product_image_upload_cleanup_v1(p_ids UUID[])
RETURNS VOID
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  UPDATE public.product_image_uploads
     SET state = 'cleaning',
         cleanup_error_count = cleanup_error_count + 1,
         cleanup_retry_after = now() + LEAST(
           interval '6 hours',
           interval '5 minutes' * power(2, LEAST(cleanup_error_count, 6)))
   WHERE id = ANY (p_ids) AND state = 'cleaning';
$$;

REVOKE EXECUTE ON FUNCTION
  public.issue_product_image_upload_v1(UUID, UUID, UUID, TEXT, INTEGER, INTEGER, INTEGER),
  public.claim_product_image_upload_v1(UUID, UUID, TEXT, INTEGER),
  public.finalize_product_image_upload_v1(UUID, UUID, TEXT),
  public.take_product_image_upload_cleanup_v1(INTEGER, INTEGER),
  public.fail_product_image_upload_cleanup_v1(UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.issue_product_image_upload_v1(UUID, UUID, UUID, TEXT, INTEGER, INTEGER, INTEGER),
  public.claim_product_image_upload_v1(UUID, UUID, TEXT, INTEGER),
  public.finalize_product_image_upload_v1(UUID, UUID, TEXT),
  public.take_product_image_upload_cleanup_v1(INTEGER, INTEGER),
  public.fail_product_image_upload_cleanup_v1(UUID[])
  TO service_role;
