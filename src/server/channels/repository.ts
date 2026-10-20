/**
 * Channel repository — raw DB operations for migration 064. Server-only.
 *
 * Every write goes through a migration-064 function (service_role only); the
 * one table read never selects credential_ciphertext except in
 * findLiveCredential, which the service decrypts in memory and never returns.
 *
 * supabaseAdmin is cast to `any` for the new table/functions because the
 * hand-authored src/lib/supabase/types.ts predates 064 — the same convention
 * as src/server/conversations/repository.ts.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import { channelDatabaseError } from "./errors";
import type { MessageRow } from "@/server/conversations/types";
import type { TelegramInbound } from "./telegram/update";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any;

export type ChannelConnectionStatus = "connected" | "error" | "disconnected";

/** Public columns only — never the credential or the secret digest. */
const PUBLIC_COLUMNS =
  "id, organization_id, provider, external_account_id, account_handle, account_display_name, status, last_inbound_at, last_outbound_at, last_error_code, last_error_at, connected_at";

export interface ChannelConnectionRow {
  id: string;
  organization_id: string;
  provider: "TELEGRAM";
  external_account_id: string;
  account_handle: string | null;
  account_display_name: string | null;
  status: ChannelConnectionStatus;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  connected_at: string;
}

function first<T>(data: unknown): T {
  return (Array.isArray(data) ? data[0] : data) as T;
}

function publicRow(row: Record<string, unknown>): ChannelConnectionRow {
  const out: Record<string, unknown> = {};
  for (const column of PUBLIC_COLUMNS.split(", ")) out[column] = row[column] ?? null;
  return out as unknown as ChannelConnectionRow;
}

export async function connectAccount(input: {
  organizationId: string;
  actorUserId: string;
  externalAccountId: string;
  handle: string | null;
  displayName: string | null;
  ciphertext: string;
  keyVersion: number;
  secretHash: string;
}): Promise<ChannelConnectionRow> {
  const { data, error } = await db
    .rpc("connect_channel_account", {
      p_org: input.organizationId,
      p_actor: input.actorUserId,
      p_provider: "TELEGRAM",
      p_external_id: input.externalAccountId,
      p_handle: input.handle,
      p_display_name: input.displayName,
      p_ciphertext: input.ciphertext,
      p_key_version: input.keyVersion,
      p_secret_hash: input.secretHash,
    })
    .single();
  if (error || !data) throw channelDatabaseError(error);
  return publicRow(first(data));
}

export async function disconnectAccount(
  organizationId: string,
  actorUserId: string,
  connectionId: string,
): Promise<ChannelConnectionRow> {
  const { data, error } = await db
    .rpc("disconnect_channel_account", {
      p_org: organizationId,
      p_actor: actorUserId,
      p_connection: connectionId,
    })
    .single();
  if (error || !data) throw channelDatabaseError(error);
  return publicRow(first(data));
}

/** The organization's live (not disconnected) connections, newest first. */
export async function listLiveConnections(organizationId: string): Promise<ChannelConnectionRow[]> {
  const { data, error } = await db
    .from("channel_connections")
    .select(PUBLIC_COLUMNS)
    .eq("organization_id", organizationId)
    .in("status", ["connected", "error"])
    .order("connected_at", { ascending: false });
  if (error) throw channelDatabaseError(error);
  return ((data ?? []) as Record<string, unknown>[]).map(publicRow);
}

/**
 * A live connection's encrypted credential, by id. organizationId is optional
 * only for the webhook, which identifies the connection by its URL and then
 * proves possession of its secret (webhook.ts) — the organization is then
 * taken FROM the row, never supplied.
 */
export async function findLiveCredential(
  connectionId: string,
  organizationId?: string,
): Promise<{
  id: string;
  organization_id: string;
  credential_ciphertext: string;
  webhook_secret_hash: string;
} | null> {
  let query = db
    .from("channel_connections")
    .select("id, organization_id, credential_ciphertext, webhook_secret_hash")
    .eq("id", connectionId)
    .in("status", ["connected", "error"]);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data, error } = await query.maybeSingle();
  if (error) throw channelDatabaseError(error);
  return data ?? null;
}

export async function ingestTelegramInbound(
  connectionId: string,
  message: TelegramInbound,
): Promise<MessageRow> {
  const { data, error } = await db
    .rpc("ingest_telegram_inbound", {
      p_connection: connectionId,
      p_chat_id: message.chatId,
      p_sender_id: message.senderId,
      p_sender_name: message.senderName,
      p_sender_handle: message.senderHandle,
      p_message_ref: message.messageRef,
      p_body: message.body,
      p_type: message.type,
      p_occurred_at: message.occurredAt,
      p_attachments: message.attachments,
    })
    .single();
  if (error || !data) throw channelDatabaseError(error);
  return first(data);
}

export interface OutboundClaim {
  message: MessageRow;
  should_send: boolean;
  connection_id: string;
  chat_id: string;
}

export async function beginOutboundMessage(input: {
  organizationId: string;
  conversationId: string;
  actorUserId: string;
  clientMessageId: string;
  body: string;
}): Promise<OutboundClaim> {
  const { data, error } = await db.rpc("begin_outbound_message", {
    p_org: input.organizationId,
    p_conversation: input.conversationId,
    p_actor: input.actorUserId,
    p_client_ref: input.clientMessageId,
    p_body: input.body,
  });
  if (error || !data) throw channelDatabaseError(error);
  return data as OutboundClaim;
}

/** Marks this conversation's replies stuck in 'sending' for over 2 minutes as failed ('send_stuck'). */
export async function failStuckOutboundMessages(
  organizationId: string,
  conversationId: string,
): Promise<number> {
  const { data, error } = await db.rpc("fail_stuck_outbound_messages", {
    p_org: organizationId,
    p_conversation: conversationId,
  });
  if (error) throw channelDatabaseError(error);
  return Number(data ?? 0);
}

export async function completeOutboundMessage(input: {
  organizationId: string;
  messageId: string;
  connectionId: string;
  sent: boolean;
  providerRef?: string;
  errorCode?: string;
}): Promise<MessageRow> {
  const { data, error } = await db
    .rpc("complete_outbound_message", {
      p_org: input.organizationId,
      p_message: input.messageId,
      p_connection: input.connectionId,
      p_sent: input.sent,
      p_provider_ref: input.providerRef ?? null,
      p_error_code: input.errorCode ?? null,
    })
    .single();
  if (error || !data) throw channelDatabaseError(error);
  return first(data);
}
