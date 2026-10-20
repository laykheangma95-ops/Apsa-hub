-- Migration: 064_telegram_channel
-- Purpose: The first real messaging provider — Telegram bots — on top of the
--          Conversation domain (031–038) and the webhook primitives (045).
--          (1) channel_connections: one row per merchant bot, holding the bot
--              token ONLY as application-encrypted ciphertext and the webhook
--              secret ONLY as a SHA-256 digest.
--          (2) connect (with a per-bot connect lease: finish / abort) and
--              disconnect, each audited in the same transaction.
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
--          public.channel_connections (NEW),
--          public.connect_channel_account (NEW), public.finish_channel_connect (NEW),
--          public.abort_channel_connect (NEW), public.disconnect_channel_account (NEW),
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
-- in X-Telegram-Bot-Api-Secret-Token is stored as its SHA-256 hex digest only.
-- Disconnecting clears the ciphertext.
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
  -- Connect lease (see §2): bumped on every connect; the operation that holds
  -- the lease is the only one that may finish or abort it.
  connect_generation     BIGINT NOT NULL DEFAULT 1 CHECK (connect_generation >= 1),
  pending_connect_op     UUID,
  pending_connect_until  TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_connections_org_id_unique UNIQUE (organization_id, id),
  -- A live connection always carries a usable credential and webhook secret;
  -- a disconnected one carries neither.
  CONSTRAINT channel_connections_credential_shape CHECK (
    (status = 'disconnected' AND credential_ciphertext IS NULL AND credential_key_version IS NULL
      AND webhook_secret_hash IS NULL AND disconnected_at IS NOT NULL)
    OR (status <> 'disconnected' AND credential_ciphertext IS NOT NULL
      AND credential_key_version IS NOT NULL AND webhook_secret_hash IS NOT NULL)
  ),
  CONSTRAINT channel_connections_lease_shape CHECK (
    (pending_connect_op IS NULL) = (pending_connect_until IS NULL)
    AND (status <> 'disconnected' OR pending_connect_op IS NULL)
  )
);

CREATE UNIQUE INDEX channel_connections_live_account
  ON public.channel_connections (provider, external_account_id)
  WHERE status <> 'disconnected';
CREATE INDEX channel_connections_org ON public.channel_connections (organization_id, provider);

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

-- ── 2. Connect / disconnect (audited in the same transaction) ───────────────
--
-- Connecting is three steps that cannot share one transaction, because the
-- middle one is a Telegram call:
--   connect_channel_account  stores the new credential + secret digest and
--                            takes the CONNECT LEASE for p_operation;
--   (app server)             setWebhook(url, secret) at Telegram;
--   finish_channel_connect   releases the lease — only for the operation
--                            that holds it;
--   abort_channel_connect    after a failed setWebhook, disconnects (audited)
--                            — only for the operation that holds it.
-- While a lease is live (60 s, well past the app's 10 s Telegram timeout) any
-- other connect of the same bot is refused 'connect_in_progress', so two
-- overlapping connects can never interleave their setWebhook calls. A lease
-- that expires (its server died) may be taken over; the older operation then
-- holds nothing: it can neither finish (connect_superseded) nor disconnect the
-- newer connection. connect_generation counts every connect for audit and
-- tests.

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
  IF p_operation IS NULL THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = p_org
    AND user_id = p_actor AND status = 'active') THEN RAISE EXCEPTION 'permission_denied'; END IF;

  -- Serialize every connect of this bot, in any organization.
  PERFORM pg_advisory_xact_lock(hashtextextended('channel_connection:' || p_provider::text || ':' || p_external_id, 0));

  SELECT * INTO v_existing FROM channel_connections
    WHERE provider = p_provider AND external_account_id = p_external_id AND status <> 'disconnected'
    FOR UPDATE;

  IF FOUND AND v_existing.organization_id <> p_org THEN
    RAISE EXCEPTION 'account_in_use';
  END IF;

  IF FOUND AND v_existing.pending_connect_op IS NOT NULL
     AND v_existing.pending_connect_op <> p_operation
     AND v_existing.pending_connect_until > clock_timestamp() THEN
    RAISE EXCEPTION 'connect_in_progress';
  END IF;

  IF FOUND THEN
    UPDATE channel_connections SET
      account_handle = p_handle,
      account_display_name = p_display_name,
      status = 'connected',
      credential_ciphertext = p_ciphertext,
      credential_key_version = p_key_version,
      webhook_secret_hash = p_secret_hash,
      last_error_code = NULL,
      last_error_at = NULL,
      connected_by = p_actor,
      connected_at = now(),
      connect_generation = v_existing.connect_generation + 1,
      pending_connect_op = p_operation,
      pending_connect_until = clock_timestamp() + interval '60 seconds'
    WHERE id = v_existing.id
    RETURNING * INTO v_row;
  ELSE
    INSERT INTO channel_connections (organization_id, provider, external_account_id, account_handle,
      account_display_name, credential_ciphertext, credential_key_version, webhook_secret_hash, connected_by,
      pending_connect_op, pending_connect_until)
    VALUES (p_org, p_provider, p_external_id, p_handle, p_display_name, p_ciphertext, p_key_version,
      p_secret_hash, p_actor, p_operation, clock_timestamp() + interval '60 seconds')
    RETURNING * INTO v_row;
  END IF;

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

-- setWebhook succeeded: release the lease. Only the operation holding it may.
CREATE FUNCTION public.finish_channel_connect(
  p_org        UUID,
  p_connection UUID,
  p_operation  UUID
)
RETURNS public.channel_connections
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row channel_connections;
BEGIN
  SELECT * INTO v_row FROM channel_connections
    WHERE organization_id = p_org AND id = p_connection FOR UPDATE;
  IF NOT FOUND OR v_row.status = 'disconnected'
     OR v_row.pending_connect_op IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION 'connect_superseded';
  END IF;
  UPDATE channel_connections SET pending_connect_op = NULL, pending_connect_until = NULL
    WHERE id = p_connection RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- setWebhook failed: the connection cannot receive — disconnect it, audited.
-- Only the operation holding the lease may; a superseded operation's cleanup
-- returns false and touches nothing.
CREATE FUNCTION public.abort_channel_connect(
  p_org        UUID,
  p_actor      UUID,
  p_connection UUID,
  p_operation  UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_before channel_connections;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = p_org
    AND user_id = p_actor AND status = 'active') THEN RAISE EXCEPTION 'permission_denied'; END IF;

  SELECT * INTO v_before FROM channel_connections
    WHERE organization_id = p_org AND id = p_connection FOR UPDATE;
  IF NOT FOUND OR v_before.status = 'disconnected'
     OR v_before.pending_connect_op IS DISTINCT FROM p_operation THEN
    RETURN false;
  END IF;

  UPDATE channel_connections SET
    status = 'disconnected',
    credential_ciphertext = NULL,
    credential_key_version = NULL,
    webhook_secret_hash = NULL,
    pending_connect_op = NULL,
    pending_connect_until = NULL,
    disconnected_at = now()
  WHERE id = p_connection;

  INSERT INTO audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, before_json, after_json)
  VALUES (p_org, p_actor, 'integrations.disconnect', 'channel_connection', p_connection::text,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', 'disconnected', 'reason', 'connect_failed',
      'generation', v_before.connect_generation));
  RETURN true;
END;
$$;

CREATE FUNCTION public.disconnect_channel_account(
  p_org        UUID,
  p_actor      UUID,
  p_connection UUID
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
    WHERE organization_id = p_org AND id = p_connection FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'connection_not_found'; END IF;
  IF v_before.status = 'disconnected' THEN RETURN v_before; END IF;

  -- Clearing the lease means an in-flight connect can neither finish nor
  -- abort this row: the member's disconnect wins.
  UPDATE channel_connections SET
    status = 'disconnected',
    credential_ciphertext = NULL,
    credential_key_version = NULL,
    webhook_secret_hash = NULL,
    pending_connect_op = NULL,
    pending_connect_until = NULL,
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
      status = CASE WHEN status = 'error' THEN 'connected'::channel_connection_status ELSE status END
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
  public.connect_channel_account(UUID, UUID, public.conversation_provider, TEXT, TEXT, TEXT, TEXT, SMALLINT, TEXT, UUID),
  public.finish_channel_connect(UUID, UUID, UUID),
  public.abort_channel_connect(UUID, UUID, UUID, UUID),
  public.disconnect_channel_account(UUID, UUID, UUID),
  public.ingest_telegram_inbound(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, public.message_content_type, TIMESTAMPTZ, JSONB, TEXT),
  public.fail_stuck_outbound_messages(UUID, UUID),
  public.begin_outbound_message(UUID, UUID, UUID, UUID, TEXT),
  public.complete_outbound_message(UUID, UUID, UUID, UUID, BOOLEAN, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.connect_channel_account(UUID, UUID, public.conversation_provider, TEXT, TEXT, TEXT, TEXT, SMALLINT, TEXT, UUID),
  public.finish_channel_connect(UUID, UUID, UUID),
  public.abort_channel_connect(UUID, UUID, UUID, UUID),
  public.disconnect_channel_account(UUID, UUID, UUID),
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
