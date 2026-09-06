-- Internal adapter foundation; service_role only. No webhooks or providers.
CREATE FUNCTION public.ensure_provider_conversation(p_org UUID, p_provider public.conversation_provider,
  p_reference TEXT, p_identity TEXT DEFAULT NULL)
RETURNS public.conversations LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_conversation conversations;
BEGIN
  IF p_reference IS NULL OR length(trim(p_reference)) NOT BETWEEN 1 AND 500 OR
     (p_identity IS NOT NULL AND length(trim(p_identity)) NOT BETWEEN 1 AND 500)
    THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  INSERT INTO conversations(organization_id, provider, provider_conversation_id)
    VALUES(p_org, p_provider, p_reference)
    ON CONFLICT (organization_id, provider, provider_conversation_id) DO NOTHING;
  SELECT * INTO v_conversation FROM conversations WHERE organization_id = p_org
    AND provider = p_provider AND provider_conversation_id = p_reference FOR UPDATE;
  IF p_identity IS NOT NULL THEN
    INSERT INTO conversation_participants(organization_id, conversation_id, provider_identity_id)
      VALUES(p_org, v_conversation.id, p_identity) ON CONFLICT DO NOTHING;
  END IF;
  UPDATE conversations SET customer_id = conversation_customer_id(p_org, v_conversation.id)
    WHERE organization_id = p_org AND id = v_conversation.id RETURNING * INTO v_conversation;
  RETURN v_conversation;
END;
$$;

CREATE FUNCTION public.ingest_conversation_message(p_org UUID, p_conversation UUID,
  p_reference TEXT, p_direction public.message_direction, p_sender public.message_sender_type,
  p_body TEXT, p_occurred_at TIMESTAMPTZ, p_sender_user UUID DEFAULT NULL,
  p_sender_identity TEXT DEFAULT NULL, p_type public.message_content_type DEFAULT 'text',
  p_attachments JSONB DEFAULT NULL)
RETURNS public.messages LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_message messages;
BEGIN
  IF (p_direction = 'inbound' AND p_sender <> 'customer') OR
     (p_direction = 'system' AND p_sender <> 'system') OR
     (p_direction = 'outbound' AND p_sender = 'customer') OR p_occurred_at IS NULL OR
     (p_type = 'text' AND (p_body IS NULL OR length(trim(p_body)) = 0))
    THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  IF p_reference IS NULL OR length(trim(p_reference)) NOT BETWEEN 1 AND 500
    THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  PERFORM 1 FROM conversations WHERE organization_id = p_org AND id = p_conversation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  IF p_sender_identity IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation_participants
    WHERE organization_id = p_org AND conversation_id = p_conversation
      AND provider_identity_id = p_sender_identity) THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  IF p_attachments IS NOT NULL AND (jsonb_typeof(p_attachments) <> 'array'
    OR octet_length(p_attachments::text) > 16000) THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  SELECT * INTO v_message FROM messages WHERE organization_id = p_org
    AND conversation_id = p_conversation AND provider_message_id = p_reference;
  IF FOUND THEN
    IF v_message.body IS DISTINCT FROM p_body OR v_message.direction IS DISTINCT FROM p_direction
      OR v_message.sender_type IS DISTINCT FROM p_sender
      OR v_message.sender_user_id IS DISTINCT FROM p_sender_user
      OR v_message.sender_provider_identity_id IS DISTINCT FROM p_sender_identity
      OR v_message.message_type IS DISTINCT FROM p_type
      OR v_message.attachments IS DISTINCT FROM p_attachments
      OR v_message.occurred_at IS DISTINCT FROM p_occurred_at
      THEN RAISE EXCEPTION 'stale_state'; END IF;
    RETURN v_message;
  END IF;
  INSERT INTO messages(organization_id, conversation_id, provider_message_id, direction, sender_type,
    body, occurred_at, sender_user_id, sender_provider_identity_id, message_type, attachments)
    VALUES(p_org, p_conversation, p_reference, p_direction, p_sender, p_body, p_occurred_at,
      p_sender_user, p_sender_identity, p_type, p_attachments) RETURNING * INTO v_message;
  RETURN v_message;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_provider_conversation(UUID, public.conversation_provider, TEXT, TEXT),
  public.ingest_conversation_message(UUID, UUID, TEXT, public.message_direction, public.message_sender_type,
    TEXT, TIMESTAMPTZ, UUID, TEXT, public.message_content_type, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_provider_conversation(UUID, public.conversation_provider, TEXT, TEXT),
  public.ingest_conversation_message(UUID, UUID, TEXT, public.message_direction, public.message_sender_type,
    TEXT, TIMESTAMPTZ, UUID, TEXT, public.message_content_type, JSONB) TO service_role;
