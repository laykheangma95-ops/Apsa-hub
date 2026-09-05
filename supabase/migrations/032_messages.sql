-- Migration: 032_messages
-- Purpose: Production Message domain — the individual messages inside a Conversation.
-- Tables: messages
-- Classification: tenant-private (scoped to organization_id)
--
-- SOURCE OF TRUTH
--   DATA_MODEL.md §25 (Message); the bounded-context contract consumed by the
--   (not-yet-merged) Cambodian intent engine / Smart Actions layer
--   (src/lib/conversation/smart-actions.ts's ContextMessage: { body, direction,
--   at }) — this table's mapped shape must satisfy that contract exactly.
--
-- PRIVACY (CLAUDE.md "Do not store unnecessary duplicate private message
--   content"): message body lives ONLY here. It is never copied into orders,
--   customers, or analytics tables — a conversation_id/message reference is
--   used instead wherever another domain needs traceability.
--
-- DELIBERATE SIMPLIFICATIONS vs DATA_MODEL.md §25 (documented, not accidental):
--   - One canonical `occurred_at` timestamp instead of separate sent_at/
--     received_at. With no live provider integration yet there is no second,
--     independently-meaningful timestamp to carry — maps 1:1 onto the
--     existing UI contract's single `Message.at` field. Add sent_at/
--     received_at back in a future migration once real provider delivery
--     timing exists to populate them honestly.
--   - `direction` includes 'system' (DATA_MODEL.md lists only INBOUND/
--     OUTBOUND) because the existing UI type (src/types/index.ts
--     MessageDirection) already has a third "system" value for
--     operational notices, and this table exists to serve that UI contract
--     without a translation layer.
--   - No MessageAttachment table this phase (DATA_MODEL.md §26): a bounded
--     `attachments` JSONB column carries safe metadata (storage key, mime
--     type, size) when a provider sends one, matching the "attachment
--     metadata if safely supported... no full media ingestion" scope note.
--     Promote to its own table if/when APSA does its own media storage.

-- ── Enums ─────────────────────────────────────────────────────────────────────

-- Mirrors src/types/index.ts MessageDirection exactly.
CREATE TYPE public.message_direction AS ENUM ('inbound', 'outbound', 'system');

CREATE TYPE public.message_sender_type AS ENUM ('customer', 'staff', 'system');

CREATE TYPE public.message_content_type AS ENUM ('text', 'image', 'video', 'audio', 'file', 'system');

-- Mirrors src/types/index.ts DeliveryState exactly.
CREATE TYPE public.message_state AS ENUM ('sending', 'sent', 'delivered', 'read', 'failed');

-- ── messages ──────────────────────────────────────────────────────────────────

CREATE TABLE public.messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_id      UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  provider_message_id  TEXT,
  direction            public.message_direction NOT NULL,
  sender_type          public.message_sender_type NOT NULL,
  -- Populated only for direction='outbound' + sender_type='staff' — the
  -- accountable staff account (DATA_MODEL.md §27 "response attribution").
  sender_user_id       UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  message_type         public.message_content_type NOT NULL DEFAULT 'text',
  body                 TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 20000),
  state                public.message_state,
  attachments          JSONB,
  metadata             JSONB,
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent provider ingestion: the same provider message can never be
-- recorded twice inside one conversation (defends webhook retries once a
-- real ingestion pipeline exists).
CREATE UNIQUE INDEX idx_messages_provider_message_unique
  ON public.messages(conversation_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ── Indexes for safe, bounded pagination ────────────────────────────────────────

CREATE INDEX idx_messages_conversation_occurred
  ON public.messages(conversation_id, occurred_at ASC, id ASC);
CREATE INDEX idx_messages_org
  ON public.messages(organization_id);

-- ── Cross-tenant integrity ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_message_cross_tenant_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_conversation_org UUID;
BEGIN
  SELECT organization_id INTO v_conversation_org
  FROM public.conversations
  WHERE id = NEW.conversation_id;

  IF v_conversation_org IS NULL THEN
    RAISE EXCEPTION 'invalid_reference: conversation_id does not exist';
  END IF;

  IF v_conversation_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'cross_tenant_violation: message organization_id must match its conversation organization_id';
  END IF;

  IF NEW.sender_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = NEW.sender_user_id
        AND m.organization_id = NEW.organization_id
        AND m.status = 'active'
    ) THEN
      RAISE EXCEPTION 'cross_tenant_violation: sender_user_id must be an active member of the organization';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_cross_tenant_refs_check
  BEFORE INSERT OR UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.check_message_cross_tenant_refs();

-- ── Conversation summary bookkeeping ─────────────────────────────────────────────
-- Keeps conversations.last_message_at / last_message_preview / unread_count
-- correct regardless of which code path inserts a message (application layer
-- today; a future webhook handler tomorrow) — pure bookkeeping only, no
-- status transitions here (those are an explicit service-layer decision, see
-- src/server/conversations/service.ts).

CREATE OR REPLACE FUNCTION public.apply_message_to_conversation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.conversations
  SET last_message_at = NEW.occurred_at,
      last_message_preview = left(NEW.body, 280),
      unread_count = CASE WHEN NEW.direction = 'inbound' THEN unread_count + 1 ELSE unread_count END,
      updated_at = now()
  WHERE id = NEW.conversation_id
    AND last_message_at <= NEW.occurred_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_apply_to_conversation
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.apply_message_to_conversation();

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages_select_member"
  ON public.messages FOR SELECT
  USING (public.is_active_member_of(organization_id));

CREATE POLICY "messages_insert_member"
  ON public.messages FOR INSERT
  WITH CHECK (public.is_active_member_of(organization_id));

-- Delivery-state updates only (e.g. sent -> delivered); message content is
-- append-only in application code, enforced structurally by RLS allowing any
-- member update is intentionally as far as the DB goes — the service layer
-- never calls update() for anything but `state`.
CREATE POLICY "messages_update_member"
  ON public.messages FOR UPDATE
  USING (public.is_active_member_of(organization_id))
  WITH CHECK (public.is_active_member_of(organization_id));

CREATE POLICY "messages_no_delete"
  ON public.messages FOR DELETE
  USING (false);
