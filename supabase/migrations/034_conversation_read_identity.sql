-- Additive continuation of 031-033. 028-029 belong exclusively to Payment.
-- No hosted migration is applied by this change.
-- Read positions use a per-conversation ingestion sequence, not provider time:
-- a delayed webhook must remain unread even if its provider timestamp is old.
-- Integrity checks run when ownership references are written, not when a
-- historical message/read summary changes after its staff member has departed.
DROP TRIGGER messages_cross_tenant_refs_check ON public.messages;
CREATE TRIGGER messages_cross_tenant_refs_check
  BEFORE INSERT OR UPDATE OF organization_id, conversation_id, sender_user_id ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.check_message_cross_tenant_refs();
DROP TRIGGER conversations_cross_tenant_refs_check ON public.conversations;
CREATE TRIGGER conversations_cross_tenant_refs_check
  BEFORE INSERT OR UPDATE OF organization_id, customer_id, workspace_id, assigned_user_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.check_conversation_cross_tenant_refs();
ALTER TABLE public.conversations ADD COLUMN message_sequence BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.messages ADD COLUMN sequence BIGINT;
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS n
  FROM public.messages
)
UPDATE public.messages m SET sequence = ranked.n FROM ranked WHERE ranked.id = m.id;
UPDATE public.conversations c SET message_sequence = COALESCE(
  (SELECT max(sequence) FROM public.messages m WHERE m.conversation_id = c.id), 0);
ALTER TABLE public.messages ALTER COLUMN sequence SET NOT NULL;
CREATE UNIQUE INDEX messages_conversation_sequence ON public.messages(conversation_id, sequence);
CREATE INDEX messages_unread_sequence ON public.messages(organization_id, conversation_id, sequence)
  WHERE direction = 'inbound';
ALTER TABLE public.conversations ADD CONSTRAINT conversations_org_id_unique UNIQUE (organization_id, id);
ALTER TABLE public.messages ADD CONSTRAINT messages_conversation_org_fk
  FOREIGN KEY (organization_id, conversation_id)
  REFERENCES public.conversations(organization_id, id) ON DELETE CASCADE;

CREATE TABLE public.conversation_read_markers (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_read_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, conversation_id, user_id),
  FOREIGN KEY (organization_id, conversation_id)
    REFERENCES public.conversations(organization_id, id) ON DELETE CASCADE
);

-- A participant is an observed provider identity, not a parallel Customer.
-- Provider identity references are resolved only against CustomerIdentity in
-- the same organization. No name/phone matching and no automatic merging.
CREATE TABLE public.conversation_participants (
  organization_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  provider_identity_id TEXT NOT NULL CHECK (length(trim(provider_identity_id)) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, conversation_id, provider_identity_id),
  FOREIGN KEY (organization_id, conversation_id)
    REFERENCES public.conversations(organization_id, id) ON DELETE CASCADE
);
ALTER TABLE public.messages ADD COLUMN sender_provider_identity_id TEXT;
ALTER TABLE public.messages ADD CONSTRAINT messages_provider_ref_nonempty
  CHECK (provider_message_id IS NULL OR length(trim(provider_message_id)) BETWEEN 1 AND 500) NOT VALID;

-- Core provider metadata stays extensible. Identity providers already include
-- TIKTOK and APSA_CONSUMER; WHATSAPP can resolve after that domain adds it.
ALTER TYPE public.conversation_provider ADD VALUE IF NOT EXISTS 'WHATSAPP';
ALTER TYPE public.conversation_provider ADD VALUE IF NOT EXISTS 'TIKTOK';
ALTER TYPE public.conversation_provider ADD VALUE IF NOT EXISTS 'APSA_CONSUMER';

CREATE FUNCTION public.conversation_customer_id(p_org UUID, p_conversation UUID)
RETURNS UUID LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM conversation_participants p
    WHERE p.organization_id = p_org AND p.conversation_id = c.id)
  THEN (SELECT CASE WHEN count(*) = count(customer.id) AND count(DISTINCT customer.id) = 1
      THEN min(ci.customer_id::text)::uuid ELSE NULL END
    FROM conversation_participants p
    LEFT JOIN customer_identities ci ON ci.organization_id = p.organization_id
      AND ci.provider::text = c.provider::text AND ci.provider_user_id = p.provider_identity_id
    LEFT JOIN customers customer ON customer.organization_id = p_org AND customer.id = ci.customer_id
    WHERE p.organization_id = p_org AND p.conversation_id = c.id)
  ELSE c.customer_id END
  FROM conversations c WHERE c.organization_id = p_org AND c.id = p_conversation;
$$;

CREATE FUNCTION public.conversation_inbox_rows(p_org UUID, p_user UUID, p_search TEXT DEFAULT NULL)
RETURNS SETOF public.conversations LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT c.id, c.organization_id, c.workspace_id, conversation_customer_id(p_org, c.id),
    c.provider, c.provider_conversation_id, c.status, c.assigned_user_id,
    (SELECT count(*)::integer FROM messages m WHERE m.organization_id = p_org
      AND m.conversation_id = c.id AND m.direction = 'inbound'
      AND m.sequence > COALESCE(r.last_read_sequence, 0)),
    c.last_message_preview, c.last_message_at, c.created_at, c.updated_at, c.message_sequence
  FROM conversations c
  LEFT JOIN conversation_read_markers r ON r.organization_id = p_org
    AND r.conversation_id = c.id AND r.user_id = p_user
  WHERE c.organization_id = p_org AND (p_search IS NULL
    OR c.last_message_preview ILIKE '%' || p_search || '%'
    OR EXISTS (SELECT 1 FROM customers customer WHERE customer.organization_id = p_org
      AND customer.id = conversation_customer_id(p_org, c.id)
      AND customer.display_name ILIKE '%' || p_search || '%'));
$$;

CREATE FUNCTION public.conversation_counts(p_org UUID, p_user UUID)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) || jsonb_build_object(
    'all', (SELECT count(*) FROM conversations WHERE organization_id = p_org),
    'unread', (SELECT count(*) FROM conversation_inbox_rows(p_org, p_user) WHERE unread_count > 0))
  FROM (SELECT status, count(*) n FROM conversations WHERE organization_id = p_org GROUP BY status) s;
$$;

CREATE FUNCTION public.mark_conversation_read(p_org UUID, p_user UUID, p_conversation UUID, p_message UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_sequence BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE organization_id = p_org
    AND user_id = p_user AND status = 'active') THEN RAISE EXCEPTION 'permission_denied'; END IF;
  IF NOT EXISTS (SELECT 1 FROM conversations WHERE organization_id = p_org AND id = p_conversation)
    THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  SELECT sequence INTO v_sequence FROM messages WHERE organization_id = p_org
    AND conversation_id = p_conversation AND id = p_message;
  IF v_sequence IS NULL THEN RAISE EXCEPTION 'message_not_found'; END IF;
  INSERT INTO conversation_read_markers(organization_id, conversation_id, user_id, last_read_sequence)
    VALUES (p_org, p_conversation, p_user, v_sequence)
  ON CONFLICT (organization_id, conversation_id, user_id) DO UPDATE
    SET last_read_sequence = greatest(conversation_read_markers.last_read_sequence, EXCLUDED.last_read_sequence),
        updated_at = now();
END;
$$;

CREATE FUNCTION public.sequence_conversation_message()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Holding the conversation row lock until commit serializes insert/read
  -- visibility. Sequences may have gaps after dedup; they are never reused.
  UPDATE conversations SET message_sequence = message_sequence + 1
    WHERE organization_id = NEW.organization_id AND id = NEW.conversation_id
    RETURNING message_sequence INTO NEW.sequence;
  IF NEW.sequence IS NULL THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER messages_sequence BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.sequence_conversation_message();

CREATE OR REPLACE FUNCTION public.apply_message_to_conversation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE conversations SET
    last_message_at = CASE WHEN NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = NEW.conversation_id
      AND id <> NEW.id) THEN NEW.occurred_at ELSE greatest(last_message_at, NEW.occurred_at) END,
    last_message_preview = CASE WHEN last_message_at <= NEW.occurred_at OR NOT EXISTS (
      SELECT 1 FROM messages WHERE conversation_id = NEW.conversation_id AND id <> NEW.id)
      THEN left(NEW.body, 280) ELSE last_message_preview END,
    unread_count = unread_count + CASE WHEN NEW.direction = 'inbound' THEN 1 ELSE 0 END,
    updated_at = now()
  WHERE organization_id = NEW.organization_id AND id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

-- All mutations and message content reads require the permission-checked API.
-- Tenant membership alone must not bypass messages.* / per-user read authority.
REVOKE ALL ON public.conversations, public.messages FROM PUBLIC, anon, authenticated;
ALTER TABLE public.conversation_read_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_read_markers, public.conversation_participants FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.conversations, public.messages, public.conversation_read_markers,
  public.conversation_participants TO service_role;
REVOKE ALL ON FUNCTION public.conversation_customer_id(UUID, UUID),
  public.conversation_inbox_rows(UUID, UUID, TEXT), public.conversation_counts(UUID, UUID),
  public.mark_conversation_read(UUID, UUID, UUID, UUID), public.sequence_conversation_message()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_customer_id(UUID, UUID),
  public.conversation_inbox_rows(UUID, UUID, TEXT), public.conversation_counts(UUID, UUID),
  public.mark_conversation_read(UUID, UUID, UUID, UUID) TO service_role;
