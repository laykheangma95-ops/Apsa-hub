-- Migration: 045_operability_rate_limits_webhooks
-- Purpose: (1) A durable, instance-shared rate-limit counter store.
--          (2) A durable webhook-event receipt store for replay protection /
--              provider-event idempotency (no provider is wired yet).
--          (3) Server-only readiness probes: the Supabase CLI migration
--              history (contiguous-application proof) and a convenience
--              marker for this migration's own objects.
-- Touches: public.rate_limit_buckets (NEW), public.consume_rate_limit (NEW),
--          public.prune_rate_limit_buckets (NEW),
--          public.webhook_event_receipts (NEW), public.claim_webhook_event (NEW),
--          public.release_webhook_event (NEW),
--          public.prune_webhook_event_receipts (NEW),
--          public.apsa_migration_history (NEW),
--          public.apsa_schema_level (NEW)
-- Classification: platform-internal. Neither table holds tenant business data
--   or PII: rate-limit keys are HMAC-SHA256 digests computed server-side (the
--   email / IP / member ID they are derived from never reaches the database),
--   and webhook receipts hold provider event IDs only — never payloads.
--
-- ADDITIVE ONLY. No existing table, function, policy or grant is changed.
--
-- ── ACCESS MODEL ────────────────────────────────────────────────────────────
--
-- Both tables have RLS ENABLED and NO policies, and every privilege is revoked
-- from anon/authenticated: a browser JWT can neither read nor write them. The
-- functions are all SECURITY DEFINER, EXECUTE revoked from PUBLIC/anon/
-- authenticated and granted to service_role only — they are called by the
-- APSA server (src/server/rate-limit/store.ts, src/server/webhooks/receipts.ts,
-- scripts/verify-readiness.ts) with the service-role client, never directly
-- by a client. A caller able to consume another caller's bucket could lock
-- them out, so client EXECUTE would be a denial-of-service primitive.
--
-- ── RATE-LIMIT WINDOW SEMANTICS ─────────────────────────────────────────────
--
-- A bucket's window starts at its FIRST hit and lasts p_window_seconds. Each
-- hit inside the window increments hit_count; the first hit at or after
-- expires_at starts a new window with hit_count = 1. Allowed ⇔ hit_count ≤
-- p_limit. Denied hits count but never extend the window.
--
-- One INSERT … ON CONFLICT DO UPDATE per hit: PostgreSQL takes the row lock on
-- conflict, so concurrent hits on one bucket from any number of server
-- instances serialize on that row and every hit is counted exactly once. The
-- time source is the database clock (now()), so application instances with
-- skewed clocks still agree on window boundaries.

-- ── 1. Rate-limit buckets ───────────────────────────────────────────────────

CREATE TABLE public.rate_limit_buckets (
  bucket_key        TEXT        PRIMARY KEY,
  rule_id           TEXT        NOT NULL,
  hit_count         INTEGER     NOT NULL CHECK (hit_count >= 1),
  window_started_at TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  CONSTRAINT rate_limit_buckets_key_format CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rate_limit_buckets_rule_format CHECK (rule_id ~ '^[a-z0-9_.]{1,64}$'),
  CONSTRAINT rate_limit_buckets_window_order CHECK (expires_at > window_started_at)
);

CREATE INDEX rate_limit_buckets_expires_at_idx ON public.rate_limit_buckets (expires_at);

COMMENT ON TABLE public.rate_limit_buckets IS
  'Fixed-window rate-limit counters (migration 045). bucket_key is an HMAC digest computed by the APSA server; no raw email, IP or member ID is stored. Server-only.';

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limit_buckets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rate_limit_buckets TO service_role;

CREATE FUNCTION public.consume_rate_limit(
  p_bucket_key     TEXT,
  p_rule_id        TEXT,
  p_limit          INTEGER,
  p_window_seconds INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now    TIMESTAMPTZ := now();
  v_window INTERVAL;
  v_count  INTEGER;
  v_expiry TIMESTAMPTZ;
BEGIN
  IF p_bucket_key IS NULL OR p_bucket_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'consume_rate_limit: invalid bucket key' USING ERRCODE = '22023';
  END IF;
  IF p_rule_id IS NULL OR p_rule_id !~ '^[a-z0-9_.]{1,64}$' THEN
    RAISE EXCEPTION 'consume_rate_limit: invalid rule id' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000000 THEN
    RAISE EXCEPTION 'consume_rate_limit: invalid limit' USING ERRCODE = '22023';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'consume_rate_limit: invalid window' USING ERRCODE = '22023';
  END IF;

  v_window := make_interval(secs => p_window_seconds);

  INSERT INTO public.rate_limit_buckets AS b
    (bucket_key, rule_id, hit_count, window_started_at, expires_at)
  VALUES
    (p_bucket_key, p_rule_id, 1, v_now, v_now + v_window)
  ON CONFLICT (bucket_key) DO UPDATE SET
    hit_count = CASE WHEN b.expires_at <= v_now THEN 1
                     ELSE LEAST(b.hit_count, 2147483646) + 1 END,
    window_started_at = CASE WHEN b.expires_at <= v_now THEN v_now
                             ELSE b.window_started_at END,
    expires_at = CASE WHEN b.expires_at <= v_now THEN v_now + v_window
                      ELSE b.expires_at END,
    rule_id = EXCLUDED.rule_id
  RETURNING b.hit_count, b.expires_at INTO v_count, v_expiry;

  -- Opportunistic housekeeping, bounded: ~1% of hits remove up to 500 buckets
  -- whose window ended over an hour ago. prune_rate_limit_buckets() does the
  -- same without a bound for scheduled maintenance.
  IF random() < 0.01 THEN
    DELETE FROM public.rate_limit_buckets
    WHERE ctid IN (
      SELECT ctid FROM public.rate_limit_buckets
      WHERE expires_at < v_now - INTERVAL '1 hour'
      LIMIT 500
    );
  END IF;

  RETURN jsonb_build_object(
    'allowed', v_count <= p_limit,
    'hit_count', v_count,
    'retry_after_seconds', GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_expiry - v_now))))::INTEGER
  );
END;
$$;

COMMENT ON FUNCTION public.consume_rate_limit(TEXT, TEXT, INTEGER, INTEGER) IS
  'Records one hit on a rate-limit bucket and reports whether it is within the limit (migration 045). Atomic per bucket across all server instances. Server-only.';

REVOKE EXECUTE ON FUNCTION public.consume_rate_limit(TEXT, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(TEXT, TEXT, INTEGER, INTEGER)
  TO service_role;

CREATE FUNCTION public.prune_rate_limit_buckets()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.rate_limit_buckets WHERE expires_at < now() - INTERVAL '1 hour';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.prune_rate_limit_buckets() IS
  'Deletes rate-limit buckets whose window ended over an hour ago; returns the count (migration 045). Server-only maintenance.';

REVOKE EXECUTE ON FUNCTION public.prune_rate_limit_buckets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_rate_limit_buckets() TO service_role;

-- ── 2. Webhook event receipts ───────────────────────────────────────────────
--
-- Replay protection / provider-event idempotency for FUTURE provider webhooks
-- (Telegram, Meta, payment providers). No provider route exists yet; this is
-- the durable half of src/server/webhooks/security.ts. A receipt is claimed
-- only AFTER the signature has been verified, so an unauthenticated caller
-- cannot fill this table.
--
-- The first claim of (provider, event_id) wins and returns true; every later
-- claim of the same pair — a provider retry or a replayed request — returns
-- false and must be acknowledged without being processed again.

CREATE TABLE public.webhook_event_receipts (
  provider    TEXT        NOT NULL,
  event_id    TEXT        NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id),
  CONSTRAINT webhook_event_receipts_provider_format CHECK (provider ~ '^[a-z0-9_]{1,32}$'),
  CONSTRAINT webhook_event_receipts_event_id_length CHECK (char_length(event_id) BETWEEN 1 AND 200)
);

CREATE INDEX webhook_event_receipts_received_at_idx ON public.webhook_event_receipts (received_at);

COMMENT ON TABLE public.webhook_event_receipts IS
  'First-seen provider webhook event IDs, for replay protection and idempotent processing (migration 045). Event IDs only — never payloads. Server-only.';

ALTER TABLE public.webhook_event_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.webhook_event_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.webhook_event_receipts TO service_role;

CREATE FUNCTION public.claim_webhook_event(
  p_provider TEXT,
  p_event_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted INTEGER;
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^[a-z0-9_]{1,32}$' THEN
    RAISE EXCEPTION 'claim_webhook_event: invalid provider' USING ERRCODE = '22023';
  END IF;
  IF p_event_id IS NULL OR char_length(p_event_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'claim_webhook_event: invalid event id' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.webhook_event_receipts (provider, event_id)
  VALUES (p_provider, p_event_id)
  ON CONFLICT (provider, event_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END;
$$;

COMMENT ON FUNCTION public.claim_webhook_event(TEXT, TEXT) IS
  'Atomically claims a provider webhook event ID; true on first sight, false for any repeat (migration 045). Server-only.';

REVOKE EXECUTE ON FUNCTION public.claim_webhook_event(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_event(TEXT, TEXT) TO service_role;

-- A claim is taken BEFORE the event is processed. If processing then fails,
-- the handler releases the claim so the provider's own retry is processed
-- instead of being acknowledged as a duplicate and lost.
CREATE FUNCTION public.release_webhook_event(
  p_provider TEXT,
  p_event_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.webhook_event_receipts
  WHERE provider = p_provider AND event_id = p_event_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END;
$$;

COMMENT ON FUNCTION public.release_webhook_event(TEXT, TEXT) IS
  'Releases a webhook event claim after failed processing so the provider retry is processed (migration 045). Server-only.';

REVOKE EXECUTE ON FUNCTION public.release_webhook_event(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_webhook_event(TEXT, TEXT) TO service_role;

-- Retention. A receipt only has to outlive every legitimate redelivery of its
-- event: the signed-timestamp tolerance (±300 s, src/server/webhooks/security.ts)
-- plus provider retry schedules (hours to ~3 days for payment providers).
-- Receipts older than the retention period (default 30 days, never less than
-- 7) are pruned in BOUNDED batches (default 5 000, at most 50 000 rows per
-- call) so a maintenance run never holds a long lock. Younger receipts — the
-- active replay records — are never touched. No cron is deployed by this
-- migration; docs/OPERABILITY.md names the maintenance call.

CREATE FUNCTION public.prune_webhook_event_receipts(
  p_retention_days INTEGER DEFAULT 30,
  p_batch_size     INTEGER DEFAULT 5000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 7 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'prune_webhook_event_receipts: retention must be 7..3650 days'
      USING ERRCODE = '22023';
  END IF;
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 50000 THEN
    RAISE EXCEPTION 'prune_webhook_event_receipts: batch size must be 1..50000'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.webhook_event_receipts r
  USING (
    SELECT provider, event_id
    FROM public.webhook_event_receipts
    WHERE received_at < now() - make_interval(days => p_retention_days)
    ORDER BY received_at
    LIMIT p_batch_size
  ) old
  WHERE r.provider = old.provider AND r.event_id = old.event_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.prune_webhook_event_receipts(INTEGER, INTEGER) IS
  'Deletes at most p_batch_size webhook receipts older than p_retention_days (default 30, minimum 7); returns the count (migration 045). Server-only maintenance.';

REVOKE EXECUTE ON FUNCTION public.prune_webhook_event_receipts(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_webhook_event_receipts(INTEGER, INTEGER)
  TO service_role;

-- ── 3. Readiness probes ─────────────────────────────────────────────────────
--
-- 3a. Migration history — the PROOF of contiguous application.
--
-- `supabase db push` / `supabase migration up` record every migration file
-- they apply, one row per file, in supabase_migrations.schema_migrations
-- (version = the file's numeric prefix, e.g. '001'). That ledger is written by
-- the migration TOOL at the moment each file runs, so a clean environment
-- applying 001 → 045 produces a truthful, complete history without any
-- historical migration file having to record itself, and without this
-- migration asserting anything about 001–044.
--
-- PostgREST does not expose the supabase_migrations schema, so this
-- SECURITY DEFINER, STABLE, read-only function returns it to the service
-- role: {"available": bool, "versions": ["001", …]}. "available": false means
-- the ledger does not exist (migrations applied by hand in the SQL editor) —
-- readiness treats that as NOT READY, never as "probably fine".
-- scripts/lib/migration-history.ts compares the versions with this checkout's
-- migration files: every file present, nothing missing, nothing unknown.

CREATE FUNCTION public.apsa_migration_history()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_versions JSONB;
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RETURN jsonb_build_object('available', false, 'versions', '[]'::jsonb);
  END IF;
  EXECUTE 'SELECT COALESCE(jsonb_agg(version::text ORDER BY version::text), ''[]''::jsonb)
             FROM supabase_migrations.schema_migrations'
    INTO v_versions;
  RETURN jsonb_build_object('available', true, 'versions', v_versions);
END;
$$;

COMMENT ON FUNCTION public.apsa_migration_history() IS
  'Read-only view of the Supabase CLI migration ledger for readiness verification (migration 045). Server-only.';

REVOKE EXECUTE ON FUNCTION public.apsa_migration_history() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apsa_migration_history() TO service_role;

-- 3b. apsa_schema_level() — a CONVENIENCE marker only.
--
-- A constant: 45 means "migration 045's own objects exist". It proves
-- NOTHING about migrations 001–044 (a database can answer 45 with an earlier
-- ALTER-only migration missing). Readiness never treats it as migration
-- proof; apsa_migration_history() above is the proof.

CREATE FUNCTION public.apsa_schema_level()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$ SELECT 45 $$;

COMMENT ON FUNCTION public.apsa_schema_level() IS
  'Convenience marker: 45 once migration 045''s objects exist. NOT proof of migrations 001-044 (see apsa_migration_history). Read-only. Server-only.';

REVOKE EXECUTE ON FUNCTION public.apsa_schema_level() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apsa_schema_level() TO service_role;
