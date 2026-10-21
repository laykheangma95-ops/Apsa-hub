-- Migration: 064_telegram_channel
-- Purpose: The first real messaging provider — Telegram bots — on top of the
--          Conversation domain (031–038) and the webhook primitives (045).
--          (1) channel_connections: one row per merchant bot, holding the bot
--              token ONLY as application-encrypted ciphertext and the webhook
--              secret ONLY as a SHA-256 digest.
--          (2) connect and disconnect, each audited in the same transaction,
--              every Telegram-side change of a bot serialized by a per-bot
--              operation lease that is held until the provider outcome is
--              KNOWN (an unknown outcome holds it "in doubt" for 5 minutes),
--              a connection reported 'connected' only after Telegram was
--              SEEN holding exactly that connect's webhook generation, and a
--              periodic reconciliation (claim / record) that re-checks every
--              live connection with or without customer traffic and repairs a
--              missing or wrong webhook under the same guard.
--          (3) ingest_telegram_inbound: one atomic, idempotent write per
--              inbound private-chat message — conversation, participant,
--              Customer + exact Telegram identity on first contact, message,
--              reopen, connection health, and the webhook replay receipt.
--          (4) begin / complete_outbound_message: an idempotent reply ledger
--              with per-attempt completion, so one composer submission is
--              sent once per claim and a late provider answer is never lost
--              or misapplied.
--          (5) integrations.* permission vocabulary (PERMISSIONS_MATRIX.md §25).
-- Touches: public.channel_connection_status (NEW TYPE),
--          public.channel_connections (NEW), public.channel_bot_operations (NEW),
--          public.begin_channel_operation (NEW), public.connect_channel_account (NEW),
--          public.settle_channel_operation (NEW), public.disconnect_channel_account (NEW),
--          public.observe_channel_webhook (NEW),
--          public.claim_channel_reconcile_batch (NEW), public.record_channel_reconcile (NEW),
--          public.webhook_event_receipts (rows only, via ingest_telegram_inbound),
--          public.ingest_telegram_inbound (NEW),
--          public.begin_outbound_message (NEW), public.complete_outbound_message (NEW),
--          public.fail_stuck_outbound_messages (NEW),
--          public.permissions / public.role_permissions (rows only)
--
-- ADDITIVE ONLY. No existing table, function, policy or grant is changed.
--
-- ── ACCESS MODEL ────────────────────────────────────────────────────────────
-- channel_connections has RLS ENABLED and NO policies; every privilege is
-- revoked from PUBLIC/anon/authenticated (061's rule for every APSA relation).
-- service_role gets SELECT, INSERT, UPDATE — never DELETE: a disconnected bot
-- keeps its row (without its credential) as the history its conversations
-- point back to.
--
-- Every function is SECURITY INVOKER, EXECUTE revoked from PUBLIC/anon/
-- authenticated and granted to service_role only (038's convention). They are
-- called by the APSA server (src/server/channels/**) after it has resolved the
-- organization from the session's active membership — or, for a webhook, from
-- the connection row the verified secret belongs to — and checked the member's
-- permission. Each function independently re-checks what the database can
-- know: the actor is an active member, the connection belongs to the
-- organization, the conversation belongs to the organization.
--
-- ── CREDENTIALS ─────────────────────────────────────────────────────────────
-- The database never holds a usable bot token. credential_ciphertext is
-- AES-256-GCM output produced by the app server with CHANNEL_CREDENTIAL_KEY,
-- a server-only secret that is not stored in this database; a database dump
-- alone cannot send as the merchant's bot. The webhook secret Telegram echoes
-- in X-Telegram-Bot-Api-Secret-Token is stored as its SHA-256 hex digest only;
-- the secret itself is derived by the app server from the connection id and
-- the connect's webhook generation with CHANNEL_CREDENTIAL_KEY, so the
-- database alone can neither read nor forge it. Disconnecting clears the
-- ciphertext.
--
-- ── ONE BOT, ONE ORGANIZATION ───────────────────────────────────────────────
-- A Telegram bot has exactly one webhook URL. Two organizations holding the
-- same bot live would each re-point it and silently steal the other's
-- customers' messages, so a bot (provider, external_account_id) may have at
-- most one non-disconnected connection across ALL organizations
-- (channel_connections_live_account). Re-connecting a bot in the organization
-- that already holds it rotates its credential and webhook secret in place.

-- ── 1. Connections ──────────────────────────────────────────────────────────

CREATE TYPE public.channel_connection_status AS ENUM ('connected', 'error', 'disconnected');

CREATE TABLE public.channel_connections (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider               public.conversation_provider NOT NULL,
  -- Telegram: the bot's numeric user id (getMe.id), as text.
  external_account_id    TEXT NOT NULL CHECK (external_account_id ~ '^[0-9]{1,20}$'),
  account_handle         TEXT CHECK (account_handle IS NULL OR char_length(account_handle) BETWEEN 1 AND 64),
  account_display_name   TEXT CHECK (account_display_name IS NULL OR char_length(account_display_name) BETWEEN 1 AND 128),
  status                 public.channel_connection_status NOT NULL DEFAULT 'connected',
  credential_ciphertext  TEXT CHECK (credential_ciphertext IS NULL OR char_length(credential_ciphertext) BETWEEN 16 AND 1024),
  credential_key_version SMALLINT CHECK (credential_key_version IS NULL OR credential_key_version >= 1),
  webhook_secret_hash    TEXT CHECK (webhook_secret_hash IS NULL OR webhook_secret_hash ~ '^[0-9a-f]{64}$'),
  last_inbound_at        TIMESTAMPTZ,
  last_outbound_at       TIMESTAMPTZ,
  last_error_code        TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  last_error_at          TIMESTAMPTZ,
  connected_by           UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  connected_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at        TIMESTAMPTZ,
  -- Counts every connect of this row (audit). webhook_generation identifies
  -- the CURRENT connect: it is part of the webhook URL Telegram is given
  -- (…/telegram/<id>/<generation>), so getWebhookInfo shows which connect
  -- Telegram actually holds, and the secret is derived from it (§2).
  connect_generation     BIGINT NOT NULL DEFAULT 1 CHECK (connect_generation >= 1),
  webhook_generation     UUID,
  -- Reconciliation (§2a): when Telegram was last SEEN holding the current
  -- generation, when the next check is due, how many checks in a row failed
  -- and why, and since when Telegram has been seen holding the wrong (or no)
  -- webhook.
  last_verified_at       TIMESTAMPTZ,
  next_reconcile_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconcile_failures     INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_failures >= 0),
  reconcile_error        TEXT CHECK (reconcile_error IS NULL OR reconcile_error ~ '^[a-z0-9_]{1,64}$'),
  mismatch_since         TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_connections_org_id_unique UNIQUE (organization_id, id),
  -- A live connection always carries a usable credential and webhook secret;
  -- a disconnected one carries neither.
  CONSTRAINT channel_connections_credential_shape CHECK (
    (status = 'disconnected' AND credential_ciphertext IS NULL AND credential_key_version IS NULL
      AND webhook_secret_hash IS NULL AND disconnected_at IS NOT NULL)
    OR (status <> 'disconnected' AND credential_ciphertext IS NOT NULL
      AND credential_key_version IS NOT NULL AND webhook_secret_hash IS NOT NULL
      AND webhook_generation IS NOT NULL)
  )
);

CREATE UNIQUE INDEX channel_connections_live_account
  ON public.channel_connections (provider, external_account_id)
  WHERE status <> 'disconnected';
CREATE INDEX channel_connections_org ON public.channel_connections (organization_id, provider);
CREATE INDEX channel_connections_reconcile_due ON public.channel_connections (next_reconcile_at)
  WHERE status <> 'disconnected';

CREATE TRIGGER channel_connections_set_updated_at
  BEFORE UPDATE ON public.channel_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.channel_connections IS
  'Merchant messaging-provider accounts (migration 064). Bot tokens are stored only as app-encrypted ciphertext and webhook secrets only as SHA-256 digests. Server-only.';

ALTER TABLE public.channel_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.channel_connections FROM PUBLIC, anon, authenticated;
-- Supabase's default privileges hand service_role ALL on a new table; take it
-- back so DELETE / TRUNCATE are never held, then grant exactly what is used.
REVOKE ALL ON TABLE public.channel_connections FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.channel_connections TO service_role;

-- One Telegram-side operation per bot at a time (§2). Keyed by the bot, not
-- by a connection row, so a disconnect and a later reconnect (a new row)
-- serialize too. Holds no credential.
CREATE TABLE public.channel_bot_operations (
  provider            public.conversation_provider NOT NULL,
  external_account_id TEXT NOT NULL CHECK (external_account_id ~ '^[0-9]{1,20}$'),
  operation_id        UUID NOT NULL UNIQUE,
  kind                TEXT NOT NULL CHECK (kind IN ('connect', 'disconnect', 'repair')),
  organization_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  connection_id       UUID,
  in_doubt            BOOLEAN NOT NULL DEFAULT false,
  expires_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider, external_account_id)
);

COMMENT ON TABLE public.channel_bot_operations IS
  'The in-flight (or in-doubt) Telegram-side operation per messaging bot (migration 064). Holds no credential. Server-only.';

ALTER TABLE public.channel_bot_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.channel_bot_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.channel_bot_operations FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_bot_operations TO service_role;

-- ── 2. Connect / disconnect (audited in the same transaction) ───────────────
--
-- Telegram's setWebhook / deleteWebhook are last-writer-wins, carry no
-- version, and an HTTP request whose answer APSA never saw may still be
-- applied after it. No database check made AFTER Telegram answers can undo
-- an older request that lands later, so the rules are about WHEN a request
-- may be sent and WHAT is reported:
--
--   1. One operation per bot. begin_channel_operation takes the bot's
--      lease (channel_bot_operations) for a connect, disconnect or repair;
--      any other operation on that bot is refused 'connect_in_progress'
--      while the lease is live. The lease outlives connection rows, so a
--      disconnect and the reconnect after it serialize as well.
--   2. Held until the outcome is known. The holder may START a Telegram
--      write only in the first 30 s of its 120 s lease (the app enforces it;
--      every call times out at 10 s). settle_channel_operation then:
--        known (answered: applied, or refused — a 4xx is never applied)
--          → releases the lease;
--        unknown (timeout, network error, 5xx: maybe applied, maybe later)
--          → keeps it IN DOUBT for 5 more minutes; nothing else touches
--            the bot until then.
--      A holder that dies simply lets the lease expire — at least 80 s
--      after its last possible request.
--   3. Seen, not assumed. Every connect has a fresh webhook_generation that
--      is part of the URL Telegram gets. After setWebhook the app reads
--      getWebhookInfo; only when Telegram's URL is exactly this
--      generation's URL — proof that Telegram holds this connect's secret —
--      is the connection settled 'connected'. Three outcomes stay distinct:
--        verified      seen holding this URL                → 'connected';
--        acknowledged  Telegram answered OK, URL not seen   → lease released
--                      (the outcome is known) but 'webhook_unverified',
--                      checked again at once by reconciliation;
--        unknown       no answer                            → in doubt.
--   4. Late answers repair, never clobber. An operation that learns it was
--      superseded (its lease was taken over) after a request of its own was
--      applied re-checks Telegram under a fresh 'repair' lease and points it
--      back at the live connection's current generation (or removes it when
--      no connection is live), then verifies.
--   5. Detected if ever violated. A delivery that carries a valid secret for
--      an OLDER generation of a live connection proves Telegram disagrees
--      with APSA: observe_channel_webhook flags it 'webhook_mismatch'.
--
-- No Telegram guarantee bounds how late a request APSA sent can still be
-- applied. Rules 1–2 make overlap unlikely; they do not prevent it. What is
-- guaranteed is DETECTION AND REPAIR, by reconciliation (§2a), whether or not
-- any customer message arrives.

CREATE FUNCTION public.begin_channel_operation(
  p_org         UUID,
  p_actor       UUID,
  p_provider    public.conversation_provider,
  p_external_id TEXT,
  p_kind        TEXT,
  p_operation   UUID,
  p_connection  UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_lease channel_bot_operations;
BEGIN
  IF p_provider <> 'TELEGRAM' THEN RAISE EXCEPTION 'provider_unsupported'; END IF;
  IF p_operation IS NULL OR p_kind IS NULL OR p_kind NOT IN ('connect', 'disconnect', 'repair')
     OR p_external_id IS NULL OR p_external_id !~ '^[0-9]{1,20}$'
    THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  -- A NULL actor is the server's own reconciliation (§2a): repair only.
  IF (p_actor IS NULL AND p_kind <> 'repair')
     OR (p_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = p_org
       AND user_id = p_actor AND status = 'active')) THEN RAISE EXCEPTION 'permission_denied'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('channel_connection:' || p_provider::text || ':' || p_external_id, 0));

  -- Refuse before Telegram is touched when another organization holds the bot.
  IF p_kind = 'connect' AND EXISTS (SELECT 1 FROM channel_connections WHERE provider = p_provider
      AND external_account_id = p_external_id AND status <> 'disconnected' AND organization_id <> p_org)
    THEN RAISE EXCEPTION 'account_in_use'; END IF;
  -- A disconnect names this organization's live connection of this bot.
  IF p_kind = 'disconnect' AND NOT EXISTS (SELECT 1 FROM channel_connections WHERE id = p_connection
      AND organization_id = p_org AND provider = p_provider AND external_account_id = p_external_id
      AND status <> 'disconnected')
    THEN RAISE EXCEPTION 'connection_not_found'; END IF;

  SELECT * INTO v_lease FROM channel_bot_operations
    WHERE provider = p_provider AND external_account_id = p_external_id FOR UPDATE;
  IF FOUND AND v_lease.expires_at > clock_timestamp() AND v_lease.operation_id <> p_operation THEN
    RAISE EXCEPTION 'connect_in_progress';
  END IF;

  INSERT INTO channel_bot_operations (provider, external_account_id, operation_id, kind,
    organization_id, connection_id, in_doubt, expires_at)
  VALUES (p_provider, p_external_id, p_operation, p_kind, p_org, p_connection, false,
    clock_timestamp() + interval '120 seconds')
  ON CONFLICT (provider, external_account_id) DO UPDATE SET
    operation_id = EXCLUDED.operation_id, kind = EXCLUDED.kind,
    organization_id = EXCLUDED.organization_id, connection_id = EXCLUDED.connection_id,
    in_doubt = false, expires_at = EXCLUDED.expires_at;
END;
$$;

-- Writes the new credential + secret digest + webhook generation under the
-- caller's live 'connect' lease. The connection is NOT 'connected' yet.
-- p_connection: the id the app derived the secret for — this organization's
-- live row of the bot, or a fresh id for a new row; anything else means the
-- caller's view is stale.
CREATE FUNCTION public.connect_channel_account(
  p_org             UUID,
  p_actor           UUID,
  p_provider        public.conversation_provider,
  p_external_id     TEXT,
  p_handle          TEXT,
  p_display_name    TEXT,
  p_ciphertext      TEXT,
  p_key_version     SMALLINT,
  p_secret_hash     TEXT,
  p_connection      UUID,
  p_generation      UUID,
  p_operation       UUID
)
RETURNS public.channel_connections
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_existing channel_connections;
  v_row      channel_connections;
BEGIN
  IF p_provider <> 'TELEGRAM' THEN RAISE EXCEPTION 'provider_unsupported'; END IF;
  IF p_operation IS NULL OR p_connection IS NULL OR p_generation IS NULL
    THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = p_org
    AND user_id = p_actor AND status = 'active') THEN RAISE EXCEPTION 'permission_denied'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('channel_connection:' || p_provider::text || ':' || p_external_id, 0));

  IF NOT EXISTS (SELECT 1 FROM channel_bot_operations WHERE provider = p_provider
      AND external_account_id = p_external_id AND operation_id = p_operation AND kind = 'connect'
      AND organization_id = p_org AND expires_at > clock_timestamp())
    THEN RAISE EXCEPTION 'connect_superseded'; END IF;

  SELECT * INTO v_existing FROM channel_connections
    WHERE provider = p_provider AND external_account_id = p_external_id AND status <> 'disconnected'
    FOR UPDATE;

  IF FOUND AND v_existing.organization_id <> p_org THEN
    RAISE EXCEPTION 'account_in_use';
  END IF;
  IF (FOUND AND v_existing.id <> p_connection)
     OR (NOT FOUND AND EXISTS (SELECT 1 FROM channel_connections WHERE id = p_connection)) THEN
    RAISE EXCEPTION 'connect_superseded';
  END IF;

  IF FOUND THEN
    UPDATE channel_connections SET
      account_handle = p_handle,
      account_display_name = p_display_name,
      status = 'error',
      credential_ciphertext = p_ciphertext,
      credential_key_version = p_key_version,
      webhook_secret_hash = p_secret_hash,
      webhook_generation = p_generation,
      last_error_code = 'webhook_pending',
      last_error_at = now(),
      connected_by = p_actor,
      connected_at = now(),
      connect_generation = v_existing.connect_generation + 1
    WHERE id = v_existing.id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO channel_connections (id, organization_id, provider, external_account_id, account_handle,
      account_display_name, status, credential_ciphertext, credential_key_version, webhook_secret_hash,
      webhook_generation, last_error_code, last_error_at, connected_by)
    VALUES (p_connection, p_org, p_provider, p_external_id, p_handle, p_display_name, 'error',
      p_ciphertext, p_key_version, p_secret_hash, p_generation, 'webhook_pending', now(), p_actor)
    RETURNING * INTO v_row;
  END IF;

  UPDATE channel_bot_operations SET connection_id = v_row.id WHERE operation_id = p_operation;

  -- Never the credential, never the secret digest.
  INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, before_json, after_json)
  VALUES (p_org, p_actor, 'integrations.connect', 'channel_connection', v_row.id::text,
    CASE WHEN v_existing.id IS NULL THEN NULL
      ELSE jsonb_build_object('status', v_existing.status, 'rotated', true) END,
    jsonb_build_object('provider', v_row.provider, 'external_account_id', v_row.external_account_id,
      'account_handle', v_row.account_handle, 'status', v_row.status,
      'generation', v_row.connect_generation));

  RETURN v_row;
END;
$$;

-- Records an operation's provider outcome and releases (or holds in doubt)
-- its lease. p_outcome:
--   'verified'  Telegram was SEEN holding p_generation's URL (connect/repair)
--               — or holding no webhook (disconnect/repair-to-none);
--   'refused'   Telegram answered "no" (or nothing was sent): not applied;
--   'unknown'   no answer: maybe applied, maybe later — lease held in doubt;
--   'done'      nothing to record on a row (a disconnect's known outcome).
-- Row effects apply only while the caller still HOLDS the lease and the row
-- still carries p_generation; a superseded operation changes nothing
-- ('held' false tells the app to re-check Telegram, rule 4).
CREATE FUNCTION public.settle_channel_operation(
  p_org         UUID,
  p_actor       UUID,
  p_operation   UUID,
  p_connection  UUID,
  p_generation  UUID,
  p_outcome     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_lease   channel_bot_operations;
  v_row     channel_connections;
  v_held    BOOLEAN;
  v_current BOOLEAN := false;
BEGIN
  IF p_operation IS NULL OR p_outcome IS NULL
     OR p_outcome NOT IN ('verified', 'acknowledged', 'refused', 'unknown', 'done')
    THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  IF p_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = p_org
    AND user_id = p_actor AND status = 'active') THEN RAISE EXCEPTION 'permission_denied'; END IF;

  SELECT * INTO v_lease FROM channel_bot_operations
    WHERE operation_id = p_operation AND organization_id = p_org;
  v_held := FOUND;
  IF v_held AND p_actor IS NULL AND v_lease.kind <> 'repair' THEN RAISE EXCEPTION 'permission_denied'; END IF;
  IF v_held THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('channel_connection:' || v_lease.provider::text
      || ':' || v_lease.external_account_id, 0));
    SELECT * INTO v_lease FROM channel_bot_operations WHERE operation_id = p_operation FOR UPDATE;
    v_held := FOUND;
  END IF;

  IF v_held AND p_connection IS NOT NULL THEN
    SELECT * INTO v_row FROM channel_connections
      WHERE id = p_connection AND provider = v_lease.provider
        AND external_account_id = v_lease.external_account_id
        AND (organization_id = p_org OR v_lease.kind = 'repair')
      FOR UPDATE;
    v_current := FOUND AND v_row.status <> 'disconnected' AND v_row.webhook_generation = p_generation;
  END IF;

  IF v_current THEN
    IF p_outcome = 'verified' THEN
      UPDATE channel_connections SET status = 'connected', last_error_code = NULL, last_error_at = NULL,
          last_verified_at = now(), reconcile_failures = 0, reconcile_error = NULL,
          mismatch_since = NULL, next_reconcile_at = now() + interval '15 minutes'
        WHERE id = p_connection RETURNING * INTO v_row;
    ELSIF p_outcome = 'acknowledged' THEN
      -- Telegram said it applied the request but APSA could not SEE it: not
      -- connected; reconciliation checks again at once.
      UPDATE channel_connections SET status = 'error', last_error_code = 'webhook_unverified',
          last_error_at = now(), next_reconcile_at = now()
        WHERE id = p_connection RETURNING * INTO v_row;
    ELSIF p_outcome = 'refused' AND v_lease.kind = 'connect' THEN
      -- Telegram never took this connect's webhook: nothing can arrive. Disconnect, audited.
      UPDATE channel_connections SET status = 'disconnected', credential_ciphertext = NULL,
          credential_key_version = NULL, webhook_secret_hash = NULL, webhook_generation = NULL,
          disconnected_at = now()
        WHERE id = p_connection RETURNING * INTO v_row;
      INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, before_json, after_json)
      VALUES (p_org, p_actor, 'integrations.disconnect', 'channel_connection', p_connection::text,
        jsonb_build_object('status', 'error'),
        jsonb_build_object('status', 'disconnected', 'reason', 'connect_failed',
          'generation', v_row.connect_generation));
    ELSIF p_outcome IN ('refused', 'unknown') THEN
      UPDATE channel_connections SET status = 'error',
          last_error_code = CASE WHEN p_outcome = 'unknown' THEN 'webhook_unverified' ELSE 'webhook_failed' END,
          last_error_at = now(),
          -- An unknown outcome is re-checked as soon as its in-doubt window ends.
          next_reconcile_at = CASE WHEN p_outcome = 'unknown'
            THEN clock_timestamp() + interval '5 minutes' ELSE now() + interval '1 minute' END
        WHERE id = p_connection RETURNING * INTO v_row;
    END IF;
  END IF;

  IF v_held THEN
    IF p_outcome = 'unknown' THEN
      UPDATE channel_bot_operations SET in_doubt = true,
          expires_at = greatest(expires_at, clock_timestamp() + interval '5 minutes')
        WHERE operation_id = p_operation;
    ELSE
      DELETE FROM channel_bot_operations WHERE operation_id = p_operation;
    END IF;
  END IF;

  RETURN jsonb_build_object('held', v_held, 'current', v_current,
    'connection', CASE WHEN v_row.id IS NULL THEN NULL
      ELSE to_jsonb(v_row) - 'credential_ciphertext' - 'webhook_secret_hash' END);
END;
$$;

-- Clears the connection (audited) under the caller's live 'disconnect' lease
-- for exactly this connection. The app calls deleteWebhook only AFTER this,
-- still holding the lease, and settles it with the provider's outcome — so a
-- reconnect cannot start while that request could still land.
CREATE FUNCTION public.disconnect_channel_account(
  p_org        UUID,
  p_actor      UUID,
  p_connection UUID,
  p_operation  UUID
)
RETURNS public.channel_connections
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_before channel_connections;
  v_row    channel_connections;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = p_org
    AND user_id = p_actor AND status = 'active') THEN RAISE EXCEPTION 'permission_denied'; END IF;

  SELECT * INTO v_before FROM channel_connections
    WHERE organization_id = p_org AND id = p_connection;
  IF NOT FOUND THEN RAISE EXCEPTION 'connection_not_found'; END IF;
  IF v_before.status = 'disconnected' THEN RETURN v_before; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('channel_connection:' || v_before.provider::text
    || ':' || v_before.external_account_id, 0));
  IF NOT EXISTS (SELECT 1 FROM channel_bot_operations WHERE operation_id = p_operation
      AND kind = 'disconnect' AND organization_id = p_org AND connection_id = p_connection
      AND expires_at > clock_timestamp())
    THEN RAISE EXCEPTION 'connect_superseded'; END IF;

  SELECT * INTO v_before FROM channel_connections WHERE id = p_connection FOR UPDATE;
  IF v_before.status = 'disconnected' THEN RETURN v_before; END IF;

  UPDATE channel_connections SET
    status = 'disconnected',
    credential_ciphertext = NULL,
    credential_key_version = NULL,
    webhook_secret_hash = NULL,
    webhook_generation = NULL,
    disconnected_at = now()
  WHERE id = p_connection
  RETURNING * INTO v_row;

  INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, before_json, after_json)
  VALUES (p_org, p_actor, 'integrations.disconnect', 'channel_connection', v_row.id::text,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', v_row.status, 'provider', v_row.provider,
      'external_account_id', v_row.external_account_id));

  RETURN v_row;
END;
$$;

-- A delivery whose secret the webhook VERIFIED, for generation p_generation of
-- a live connection, is evidence of what Telegram holds. With no operation
-- in flight on the bot: the current generation confirms an unverified
-- connection; an older generation means Telegram and APSA disagree.
CREATE FUNCTION public.observe_channel_webhook(
  p_connection UUID,
  p_generation UUID
)
RETURNS public.channel_connection_status
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row channel_connections;
BEGIN
  SELECT * INTO v_row FROM channel_connections
    WHERE id = p_connection AND status <> 'disconnected' FOR UPDATE;
  IF NOT FOUND OR p_generation IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM channel_bot_operations WHERE provider = v_row.provider
      AND external_account_id = v_row.external_account_id AND expires_at > clock_timestamp())
    THEN RETURN v_row.status; END IF;

  IF v_row.webhook_generation = p_generation THEN
    IF v_row.status = 'error'
       AND v_row.last_error_code IN ('webhook_unverified', 'webhook_mismatch', 'webhook_missing') THEN
      UPDATE channel_connections SET status = 'connected', last_error_code = NULL, last_error_at = NULL,
          last_verified_at = now(), reconcile_failures = 0, reconcile_error = NULL, mismatch_since = NULL
        WHERE id = p_connection RETURNING * INTO v_row;
    ELSIF v_row.status = 'connected' THEN
      UPDATE channel_connections SET last_verified_at = now()
        WHERE id = p_connection RETURNING * INTO v_row;
    END IF;
  ELSIF v_row.status = 'connected' THEN
    UPDATE channel_connections SET status = 'error', last_error_code = 'webhook_mismatch',
        last_error_at = now(), mismatch_since = COALESCE(mismatch_since, now()),
        next_reconcile_at = now()
      WHERE id = p_connection RETURNING * INTO v_row;
  END IF;
  RETURN v_row.status;
END;
$$;

-- ── 2a. Reconciliation ──────────────────────────────────────────────────────
-- A Telegram request APSA sent can be applied arbitrarily late (a timed-out
-- deleteWebhook after a newer connect silences the bot; nothing arrives to
-- reveal it). Reconciliation finds that without customer traffic:
--
--   worker   any number of runs of /api/internal/channels/reconcile (a
--            scheduler, CRON_SECRET-authorized) — no single owner needed.
--   claim    claim_channel_reconcile_batch takes up to p_limit DUE live
--            connections with FOR UPDATE SKIP LOCKED and pushes their next
--            check 2 minutes out: concurrent runs never take the same row,
--            and a run that dies hands its rows back after 2 minutes.
--   check    getWebhookInfo (read-only, no lease). Right URL → healthy.
--            Missing / wrong → repair under the bot's 'repair' operation
--            lease (§2), then SEE it again. Bot busy → retry in 1 minute.
--   record   record_channel_reconcile: healthy → verified now, next check in
--            15 minutes; failed → failures + 1, retry after
--            min(60, 2^(failures-1)) minutes; a missing / wrong webhook is
--            'error' (webhook_missing / webhook_mismatch, since
--            mismatch_since) until repaired; no successful observation for
--            60 minutes → 'webhook_unverified'.
--
-- Both apply only to the generation the run observed: a member's connect or
-- disconnect in between is never overwritten.

CREATE FUNCTION public.claim_channel_reconcile_batch(
  p_limit INTEGER
)
RETURNS TABLE (
  id                    UUID,
  organization_id       UUID,
  external_account_id   TEXT,
  webhook_generation    UUID,
  credential_ciphertext TEXT,
  reconcile_failures    INTEGER
)
LANGUAGE plpgsql
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  RETURN QUERY
  WITH due AS (
    SELECT c.id FROM channel_connections c
     WHERE c.status <> 'disconnected' AND c.next_reconcile_at <= now()
     ORDER BY c.next_reconcile_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE channel_connections c SET next_reconcile_at = now() + interval '2 minutes'
    FROM due WHERE c.id = due.id
  RETURNING c.id, c.organization_id, c.external_account_id, c.webhook_generation,
    c.credential_ciphertext, c.reconcile_failures;
END;
$$;

-- p_result: 'healthy' | 'repaired' (Telegram SEEN holding p_generation) |
-- 'missing' | 'mismatch' (seen holding no / another webhook, not repaired) |
-- 'unobservable' (getWebhookInfo failed) | 'busy' (another operation holds
-- the bot). Returns the row's state after recording (never a credential).
CREATE FUNCTION public.record_channel_reconcile(
  p_connection UUID,
  p_generation UUID,
  p_result     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row     channel_connections;
  v_busy    BOOLEAN;
  v_backoff INTERVAL;
BEGIN
  IF p_result IS NULL OR p_result NOT IN ('healthy', 'repaired', 'missing', 'mismatch',
      'unobservable', 'busy') THEN RAISE EXCEPTION 'invalid_reference'; END IF;

  SELECT * INTO v_row FROM channel_connections
    WHERE id = p_connection AND status <> 'disconnected' FOR UPDATE;
  IF NOT FOUND OR v_row.webhook_generation IS DISTINCT FROM p_generation THEN
    -- Disconnected or reconnected since the run observed it: not this run's to record.
    RETURN jsonb_build_object('recorded', false);
  END IF;
  v_busy := EXISTS (SELECT 1 FROM channel_bot_operations WHERE provider = v_row.provider
    AND external_account_id = v_row.external_account_id AND expires_at > clock_timestamp());

  IF p_result IN ('healthy', 'repaired') THEN
    UPDATE channel_connections SET last_verified_at = now(), reconcile_failures = 0,
        reconcile_error = NULL, mismatch_since = NULL, next_reconcile_at = now() + interval '15 minutes',
        status = CASE WHEN v_busy THEN status ELSE 'connected'::channel_connection_status END,
        last_error_code = CASE WHEN v_busy THEN last_error_code ELSE NULL END,
        last_error_at = CASE WHEN v_busy THEN last_error_at ELSE NULL END
      WHERE id = p_connection RETURNING * INTO v_row;
  ELSIF p_result = 'busy' THEN
    UPDATE channel_connections SET next_reconcile_at = now() + interval '1 minute'
      WHERE id = p_connection RETURNING * INTO v_row;
  ELSE
    v_backoff := least(interval '60 minutes',
      interval '1 minute' * power(2, least(v_row.reconcile_failures, 6)));
    UPDATE channel_connections SET
        reconcile_failures = reconcile_failures + 1,
        reconcile_error = 'webhook_' || p_result,
        next_reconcile_at = now() + v_backoff,
        mismatch_since = CASE WHEN p_result IN ('missing', 'mismatch')
          THEN COALESCE(mismatch_since, now()) ELSE mismatch_since END,
        status = CASE
          WHEN v_busy THEN status
          WHEN p_result IN ('missing', 'mismatch') THEN 'error'::channel_connection_status
          WHEN last_verified_at IS NULL OR last_verified_at < now() - interval '60 minutes'
            THEN 'error'::channel_connection_status
          ELSE status END,
        last_error_code = CASE
          WHEN v_busy THEN last_error_code
          WHEN p_result IN ('missing', 'mismatch') THEN 'webhook_' || p_result
          WHEN last_verified_at IS NULL OR last_verified_at < now() - interval '60 minutes'
            THEN 'webhook_unverified'
          ELSE last_error_code END,
        last_error_at = CASE WHEN v_busy THEN last_error_at ELSE now() END
      WHERE id = p_connection RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object('recorded', true, 'status', v_row.status,
    'last_error_code', v_row.last_error_code, 'reconcile_failures', v_row.reconcile_failures,
    'mismatch_since', v_row.mismatch_since, 'next_reconcile_at', v_row.next_reconcile_at);
END;
$$;

-- ── 3. Inbound ingestion ────────────────────────────────────────────────────
-- The organization is never a parameter: it is the connection's. A webhook
-- request reaches this function only after its secret matched that
-- connection's digest (src/server/channels/telegram/webhook.ts).
--
-- Conversation reference: 'tg:<bot id>:<chat id>' — the same customer talking
-- to two of the merchant's bots is two threads, each answerable by its own bot.
-- Message reference: 'tg:<message_id>' — unique within a chat, so a redelivered
-- update returns the stored row (ingest_conversation_message's idempotency).
--
-- Replay receipt: the webhook does NOT claim the update before calling this
-- function (a crash between such a claim and this write would have turned
-- Telegram's retry into a "duplicate" and lost the message). It only LOOKS the
-- receipt up; this function records webhook_event_receipts
-- ('telegram', '<connection id>:<update_id>') in the SAME transaction as the
-- message. Either both commit or neither does, so a retry after any crash is
-- processed, and a retry after the commit is acknowledged as a duplicate.
--
-- Customer on first contact: when no CustomerIdentity holds this exact
-- Telegram user id in this organization, a Customer and its TELEGRAM identity
-- are created together. This is never a match or a merge — there is no name,
-- handle or phone comparison; the identity unique index (012) guarantees one
-- Customer per Telegram account per organization, and the advisory lock makes
-- two concurrent first messages create exactly one.

CREATE FUNCTION public.ingest_telegram_inbound(
  p_connection   UUID,
  p_chat_id      TEXT,
  p_sender_id    TEXT,
  p_sender_name  TEXT,
  p_sender_handle TEXT,
  p_message_ref  TEXT,
  p_body         TEXT,
  p_type         public.message_content_type,
  p_occurred_at  TIMESTAMPTZ,
  p_attachments  JSONB,
  p_update_id    TEXT
)
RETURNS public.messages
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_connection   channel_connections;
  v_conversation conversations;
  v_message      messages;
  v_customer     UUID;
  v_name         TEXT;
  v_inserted     INTEGER;
BEGIN
  IF p_chat_id IS NULL OR p_chat_id !~ '^-?[0-9]{1,20}$'
     OR p_sender_id IS NULL OR p_sender_id !~ '^[0-9]{1,20}$'
     OR p_message_ref IS NULL OR p_message_ref !~ '^tg:[0-9]{1,20}$'
     OR p_update_id IS NULL OR p_update_id !~ '^[0-9]{1,20}$'
    THEN RAISE EXCEPTION 'invalid_reference'; END IF;

  SELECT * INTO v_connection FROM channel_connections
    WHERE id = p_connection AND provider = 'TELEGRAM' AND status <> 'disconnected';
  IF NOT FOUND THEN RAISE EXCEPTION 'connection_not_found'; END IF;

  -- The replay receipt commits with the message, or not at all. Taken FIRST:
  -- a concurrent copy of the same update waits here on the uncommitted
  -- receipt; if that copy commits, this one is a replay and returns the
  -- stored message without re-ingesting; if it rolls back, this one proceeds.
  INSERT INTO webhook_event_receipts (provider, event_id)
    VALUES ('telegram', v_connection.id::text || ':' || p_update_id)
    ON CONFLICT (provider, event_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    SELECT m.* INTO v_message FROM messages m
      JOIN conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id
      WHERE m.organization_id = v_connection.organization_id
        AND c.provider = 'TELEGRAM'
        AND c.provider_conversation_id = 'tg:' || v_connection.external_account_id || ':' || p_chat_id
        AND m.provider_message_id = p_message_ref;
    IF FOUND THEN RETURN v_message; END IF;
  END IF;

  -- Customer + exact identity on first contact.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'telegram_identity:' || v_connection.organization_id::text || ':' || p_sender_id, 0));
  SELECT customer_id INTO v_customer FROM customer_identities
    WHERE organization_id = v_connection.organization_id AND provider = 'TELEGRAM'
      AND provider_user_id = p_sender_id;
  IF NOT FOUND THEN
    v_name := left(COALESCE(NULLIF(trim(p_sender_name), ''),
      CASE WHEN NULLIF(trim(p_sender_handle), '') IS NOT NULL THEN '@' || trim(p_sender_handle) END,
      'Telegram ' || p_sender_id), 200);
    INSERT INTO customers (organization_id, display_name, first_seen_at, last_seen_at)
      VALUES (v_connection.organization_id, v_name, p_occurred_at, p_occurred_at)
      RETURNING id INTO v_customer;
    INSERT INTO customer_identities (organization_id, customer_id, provider, provider_user_id,
      handle, display_name, confidence, verified_at)
    VALUES (v_connection.organization_id, v_customer, 'TELEGRAM', p_sender_id,
      left(NULLIF(trim(p_sender_handle), ''), 64), left(NULLIF(trim(p_sender_name), ''), 200), 100, now());
  ELSE
    UPDATE customers SET last_seen_at = greatest(COALESCE(last_seen_at, p_occurred_at), p_occurred_at)
      WHERE organization_id = v_connection.organization_id AND id = v_customer;
  END IF;

  -- Conversation + participant; its customer resolves through the identity.
  v_conversation := ensure_provider_conversation(v_connection.organization_id, 'TELEGRAM',
    'tg:' || v_connection.external_account_id || ':' || p_chat_id, p_sender_id);

  v_message := ingest_conversation_message(v_connection.organization_id, v_conversation.id,
    p_message_ref, 'inbound', 'customer', COALESCE(p_body, ''), p_occurred_at, NULL, p_sender_id,
    p_type, p_attachments);

  -- A customer writing again reopens a thread the merchant had parked.
  UPDATE conversations SET status = 'needs_reply'
    WHERE organization_id = v_connection.organization_id AND id = v_conversation.id
      AND status IN ('closed', 'waiting_customer');

  UPDATE channel_connections SET last_inbound_at = greatest(COALESCE(last_inbound_at, now()), now()),
      status = CASE WHEN status = 'error' AND last_error_code IS DISTINCT FROM 'webhook_pending'
          AND last_error_code IS DISTINCT FROM 'webhook_unverified'
          AND last_error_code IS DISTINCT FROM 'webhook_mismatch'
          AND last_error_code IS DISTINCT FROM 'webhook_missing'
        THEN 'connected'::channel_connection_status ELSE status END
    WHERE id = v_connection.id;

  RETURN v_message;
END;
$$;

-- ── 4. Outbound replies ─────────────────────────────────────────────────────
-- Telegram's sendMessage is not idempotent, so APSA keeps the ledger:
--   begin_outbound_message   records the reply under the composer's client
--                            key ('apsa:<uuid>') and claims the right to send.
--                            should_send is true for exactly one caller: the
--                            first submission, or a retry of a FAILED send.
--                            A retry of a reply that is 'sending' or 'sent'
--                            gets the stored row and must not send again.
--                            Every claim mints a SENDING ATTEMPT id
--                            (metadata.send_attempt, history in
--                            metadata.send_attempts) returned as 'attempt'.
--   complete_outbound_message records one attempt's provider outcome. Only
--                            an attempt of this message is accepted
--                            (anything else is stale_state):
--                              * the CURRENT attempt decides the state
--                                ('sending', or a 'send_stuck' sweep of it);
--                              * an OLDER attempt (superseded by a retry)
--                                that reports success is recorded in
--                                metadata.delivered_refs, and a reply that is
--                                not currently sending becomes 'sent' — the
--                                customer has it;
--                              * an older attempt that reports failure
--                                changes nothing;
--                              * a current failure on a reply that some
--                                attempt already delivered records 'sent'.
--   fail_stuck_outbound_messages marks a reply 'sending' for over 2 minutes
--                            (its sender died, or Telegram never answered) as
--                            failed with 'send_stuck'. That proves nothing
--                            about delivery: the UI says it is UNCONFIRMED.
-- begin holds the conversation row lock and complete the message row lock, so
-- concurrent identical submissions serialize and exactly one is told to send.

CREATE FUNCTION public.fail_stuck_outbound_messages(
  p_org          UUID,
  p_conversation UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE messages SET
    state = CASE WHEN jsonb_array_length(COALESCE(metadata->'delivered_refs', '[]'::jsonb)) > 0
      THEN 'sent'::message_state ELSE 'failed'::message_state END,
    metadata = CASE WHEN jsonb_array_length(COALESCE(metadata->'delivered_refs', '[]'::jsonb)) > 0
      THEN COALESCE(metadata, '{}'::jsonb) - 'send_error'
      ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('send_error', 'send_stuck') END
  WHERE organization_id = p_org AND conversation_id = p_conversation
    AND direction = 'outbound' AND state = 'sending'
    AND COALESCE((metadata->>'sending_since')::timestamptz, created_at) < now() - interval '2 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.begin_outbound_message(
  p_org          UUID,
  p_conversation UUID,
  p_actor        UUID,
  p_client_ref   UUID,
  p_body         TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_conversation conversations;
  v_connection   channel_connections;
  v_message      messages;
  v_ref          TEXT := 'apsa:' || p_client_ref::text;
  v_parts        TEXT[];
  v_send         BOOLEAN := false;
  v_attempt      UUID;
BEGIN
  IF p_client_ref IS NULL OR p_body IS NULL OR length(trim(p_body)) = 0 OR char_length(p_body) > 4096
    THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = p_org
    AND user_id = p_actor AND status = 'active') THEN RAISE EXCEPTION 'permission_denied'; END IF;

  SELECT * INTO v_conversation FROM conversations
    WHERE organization_id = p_org AND id = p_conversation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  IF v_conversation.provider <> 'TELEGRAM' THEN RAISE EXCEPTION 'channel_unavailable'; END IF;

  v_parts := regexp_match(v_conversation.provider_conversation_id, '^tg:([0-9]{1,20}):(-?[0-9]{1,20})$');
  IF v_parts IS NULL THEN RAISE EXCEPTION 'channel_unavailable'; END IF;

  SELECT * INTO v_connection FROM channel_connections
    WHERE organization_id = p_org AND provider = 'TELEGRAM' AND external_account_id = v_parts[1]
      AND status <> 'disconnected';
  IF NOT FOUND THEN RAISE EXCEPTION 'channel_unavailable'; END IF;

  PERFORM fail_stuck_outbound_messages(p_org, p_conversation);

  SELECT * INTO v_message FROM messages
    WHERE organization_id = p_org AND conversation_id = p_conversation AND provider_message_id = v_ref
    FOR UPDATE;

  IF FOUND THEN
    -- The same key must mean the same reply by the same member.
    IF v_message.body IS DISTINCT FROM p_body OR v_message.sender_user_id IS DISTINCT FROM p_actor
       OR v_message.direction <> 'outbound' THEN RAISE EXCEPTION 'stale_state'; END IF;
    IF v_message.state = 'failed' THEN
      v_attempt := gen_random_uuid();
      UPDATE messages SET state = 'sending',
          metadata = (COALESCE(metadata, '{}'::jsonb) - 'send_error')
            || jsonb_build_object('sending_since', now(), 'send_attempt', v_attempt::text,
                 'send_attempts', COALESCE(metadata->'send_attempts', '[]'::jsonb)
                   || to_jsonb(v_attempt::text))
        WHERE id = v_message.id RETURNING * INTO v_message;
      v_send := true;
    END IF;
  ELSE
    v_attempt := gen_random_uuid();
    v_message := ingest_conversation_message(p_org, p_conversation, v_ref, 'outbound', 'staff',
      p_body, now(), p_actor, NULL, 'text', NULL);
    UPDATE messages SET state = 'sending',
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('sending_since', now(),
          'send_attempt', v_attempt::text, 'send_attempts', jsonb_build_array(v_attempt::text))
      WHERE id = v_message.id RETURNING * INTO v_message;
    v_send := true;
  END IF;

  RETURN jsonb_build_object(
    'message', to_jsonb(v_message),
    'should_send', v_send,
    'attempt', v_attempt,
    'connection_id', v_connection.id,
    'chat_id', v_parts[2]);
END;
$$;

CREATE FUNCTION public.complete_outbound_message(
  p_org          UUID,
  p_message      UUID,
  p_connection   UUID,
  p_attempt      UUID,
  p_sent         BOOLEAN,
  p_provider_ref TEXT DEFAULT NULL,
  p_error_code   TEXT DEFAULT NULL
)
RETURNS public.messages
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_message  messages;
  v_current  BOOLEAN;
  v_refs     JSONB;
  v_applied  BOOLEAN := false;
BEGIN
  IF p_attempt IS NULL THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  IF p_sent AND (p_provider_ref IS NULL OR p_provider_ref !~ '^[0-9]{1,20}$')
    THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  IF NOT p_sent AND (p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_]{1,64}$')
    THEN RAISE EXCEPTION 'invalid_reference'; END IF;

  SELECT * INTO v_message FROM messages
    WHERE organization_id = p_org AND id = p_message AND direction = 'outbound' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale_state'; END IF;
  -- Only an attempt this message actually issued may report on it.
  IF NOT (COALESCE(v_message.metadata->'send_attempts', '[]'::jsonb) ? p_attempt::text)
    THEN RAISE EXCEPTION 'stale_state'; END IF;
  v_current := v_message.metadata->>'send_attempt' = p_attempt::text;
  v_refs := COALESCE(v_message.metadata->'delivered_refs', '[]'::jsonb);

  IF p_sent THEN
    IF NOT v_refs ? p_provider_ref THEN v_refs := v_refs || to_jsonb(p_provider_ref); END IF;
    IF v_message.state = 'sending' AND NOT v_current THEN
      -- A newer attempt is in flight: remember the delivery, let it finish.
      UPDATE messages SET metadata = metadata || jsonb_build_object('delivered_refs', v_refs)
        WHERE id = v_message.id RETURNING * INTO v_message;
    ELSIF v_message.state = 'sent' THEN
      -- Already delivered by another attempt: a duplicate, recorded as such.
      UPDATE messages SET metadata = metadata || jsonb_build_object('delivered_refs', v_refs)
        WHERE id = v_message.id RETURNING * INTO v_message;
    ELSE
      UPDATE messages SET state = 'sent',
          metadata = (metadata - 'send_error') || jsonb_build_object(
            'telegram_message_id', p_provider_ref, 'delivered_refs', v_refs)
        WHERE id = v_message.id RETURNING * INTO v_message;
    END IF;
    v_applied := true;
  ELSIF v_current AND (v_message.state = 'sending'
        OR (v_message.state = 'failed' AND v_message.metadata->>'send_error' = 'send_stuck')) THEN
    IF jsonb_array_length(v_refs) > 0 THEN
      -- An earlier attempt reached the customer; this one's failure doesn't undo that.
      UPDATE messages SET state = 'sent',
          metadata = (metadata - 'send_error')
            || jsonb_build_object('telegram_message_id', v_refs->>0)
        WHERE id = v_message.id RETURNING * INTO v_message;
    ELSE
      UPDATE messages SET state = 'failed',
          metadata = metadata || jsonb_build_object('send_error', p_error_code)
        WHERE id = v_message.id RETURNING * INTO v_message;
      v_applied := true;
    END IF;
  END IF;
  -- Otherwise: a superseded attempt's failure. Nothing changes.

  IF v_applied THEN
    UPDATE channel_connections SET
      last_outbound_at = CASE WHEN p_sent THEN now() ELSE last_outbound_at END,
      last_error_code = CASE WHEN p_sent THEN last_error_code ELSE p_error_code END,
      last_error_at = CASE WHEN p_sent THEN last_error_at ELSE now() END
    WHERE organization_id = p_org AND id = p_connection;
  END IF;

  RETURN v_message;
END;
$$;

REVOKE ALL ON FUNCTION
  public.begin_channel_operation(UUID, UUID, public.conversation_provider, TEXT, TEXT, UUID, UUID),
  public.connect_channel_account(UUID, UUID, public.conversation_provider, TEXT, TEXT, TEXT, TEXT, SMALLINT, TEXT, UUID, UUID, UUID),
  public.settle_channel_operation(UUID, UUID, UUID, UUID, UUID, TEXT),
  public.disconnect_channel_account(UUID, UUID, UUID, UUID),
  public.observe_channel_webhook(UUID, UUID),
  public.claim_channel_reconcile_batch(INTEGER),
  public.record_channel_reconcile(UUID, UUID, TEXT),
  public.ingest_telegram_inbound(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, public.message_content_type, TIMESTAMPTZ, JSONB, TEXT),
  public.fail_stuck_outbound_messages(UUID, UUID),
  public.begin_outbound_message(UUID, UUID, UUID, UUID, TEXT),
  public.complete_outbound_message(UUID, UUID, UUID, UUID, BOOLEAN, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.begin_channel_operation(UUID, UUID, public.conversation_provider, TEXT, TEXT, UUID, UUID),
  public.connect_channel_account(UUID, UUID, public.conversation_provider, TEXT, TEXT, TEXT, TEXT, SMALLINT, TEXT, UUID, UUID, UUID),
  public.settle_channel_operation(UUID, UUID, UUID, UUID, UUID, TEXT),
  public.disconnect_channel_account(UUID, UUID, UUID, UUID),
  public.observe_channel_webhook(UUID, UUID),
  public.claim_channel_reconcile_batch(INTEGER),
  public.record_channel_reconcile(UUID, UUID, TEXT),
  public.ingest_telegram_inbound(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, public.message_content_type, TIMESTAMPTZ, JSONB, TEXT),
  public.fail_stuck_outbound_messages(UUID, UUID),
  public.begin_outbound_message(UUID, UUID, UUID, UUID, TEXT),
  public.complete_outbound_message(UUID, UUID, UUID, UUID, BOOLEAN, TEXT, TEXT)
  TO service_role;

-- ── 5. Permission vocabulary (PERMISSIONS_MATRIX.md §25) ────────────────────
--                               Owner  Manager  Cashier  Sales  CS
--   integrations.read             ✅      ✅       ❌       ❌     ❌
--   integrations.view_health      ✅      ✅       ❌       ⚠️     ⚠️   (⚠️ not granted)
--   integrations.connect          ✅      ⚠️       ❌       ❌     ❌   (⚠️ not granted)
--   integrations.disconnect       ✅      ⚠️       ❌       ❌     ❌   (⚠️ not granted)
-- Connecting hands APSA a bot credential; until a conditional Manager grant
-- is designed, only the Owner holds it.

INSERT INTO public.permissions (key, description, risk_level) VALUES
  ('integrations.read',        'View connected messaging channels',          'low'),
  ('integrations.view_health', 'View messaging channel connection health',   'low'),
  ('integrations.connect',     'Connect or re-connect a messaging channel',  'high'),
  ('integrations.disconnect',  'Disconnect a messaging channel',             'high')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  v_owner_id   UUID;
  v_manager_id UUID;
  v_perm_id    UUID;
  v_role       UUID;
BEGIN
  SELECT id INTO v_owner_id   FROM public.roles WHERE system_role = 'OWNER'   AND organization_id IS NULL;
  SELECT id INTO v_manager_id FROM public.roles WHERE system_role = 'MANAGER' AND organization_id IS NULL;
  IF v_owner_id IS NULL OR v_manager_id IS NULL THEN
    RAISE EXCEPTION 'System roles OWNER/MANAGER not found — ensure migration 003 has been applied.';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    FOR v_perm_id IN SELECT id FROM public.permissions
      WHERE key IN ('integrations.read', 'integrations.view_health') LOOP
      INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  FOR v_perm_id IN SELECT id FROM public.permissions
    WHERE key IN ('integrations.connect', 'integrations.disconnect') LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_owner_id, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;
