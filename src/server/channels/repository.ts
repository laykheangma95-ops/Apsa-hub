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
  "id, organization_id, provider, external_account_id, account_handle, account_display_name, status, last_inbound_at, last_outbound_at, last_error_code, last_error_at, connected_at, last_verified_at, mismatch_since";

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
  /** When Telegram was last SEEN holding this connection's current webhook generation. */
  last_verified_at: string | null;
  /** Since when Telegram has been seen holding no / another webhook (unrepaired). */
  mismatch_since: string | null;
}

function first<T>(data: unknown): T {
  return (Array.isArray(data) ? data[0] : data) as T;
}

function publicRow(row: Record<string, unknown>): ChannelConnectionRow {
  const out: Record<string, unknown> = {};
  for (const column of PUBLIC_COLUMNS.split(", ")) out[column] = row[column] ?? null;
  return out as unknown as ChannelConnectionRow;
}

export type ChannelOperationKind = "connect" | "disconnect" | "repair";

/**
 * Takes the bot's operation lease (migration 064 §2) for `operationId`.
 * Refused 'connect_in_progress' while another operation on this bot — or one
 * whose provider outcome is still unknown — holds it.
 */
export async function beginOperation(input: {
  organizationId: string;
  /** null only for the server's own reconciliation ('repair'). */
  actorUserId: string | null;
  externalAccountId: string;
  kind: ChannelOperationKind;
  operationId: string;
  connectionId?: string | null;
}): Promise<void> {
  const { error } = await db.rpc("begin_channel_operation", {
    p_org: input.organizationId,
    p_actor: input.actorUserId,
    p_provider: "TELEGRAM",
    p_external_id: input.externalAccountId,
    p_kind: input.kind,
    p_operation: input.operationId,
    p_connection: input.connectionId ?? null,
  });
  if (error) throw channelDatabaseError(error);
}

/** Stores the new credential + digest + webhook generation under the operation's connect lease (not yet 'connected'). */
export async function connectAccount(input: {
  organizationId: string;
  actorUserId: string;
  externalAccountId: string;
  handle: string | null;
  displayName: string | null;
  ciphertext: string;
  keyVersion: number;
  secretHash: string;
  /** The id the secret was derived for: this organization's live row of the bot, or a fresh id. */
  connectionId: string;
  generation: string;
  operationId: string;
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
      p_connection: input.connectionId,
      p_generation: input.generation,
      p_operation: input.operationId,
    })
    .single();
  if (error || !data) throw channelDatabaseError(error);
  return publicRow(first(data));
}

/**
 * verified      Telegram SEEN holding the expected URL (or none, for a removal);
 * acknowledged  Telegram answered OK but the result could not be read back;
 * refused       Telegram answered "no" (never applied), or nothing was sent;
 * unknown       no answer — maybe applied, maybe later;
 * done          nothing to record on a row;
 * stale_key     the current key no longer derives the stored secret — nothing
 *               was sent (a repair would have created a URL/secret mismatch).
 */
export type ProviderOutcome =
  "verified" | "acknowledged" | "refused" | "unknown" | "done" | "stale_key";

/**
 * Records an operation's provider outcome and releases its lease — or, for
 * 'unknown', holds it in doubt. `held` false: the operation was superseded and
 * changed nothing; `current` true: the row still carried `generation`.
 */
export async function settleOperation(input: {
  organizationId: string;
  actorUserId: string | null;
  operationId: string;
  connectionId: string | null;
  generation: string | null;
  outcome: ProviderOutcome;
}): Promise<{ held: boolean; current: boolean; connection: ChannelConnectionRow | null }> {
  const { data, error } = await db.rpc("settle_channel_operation", {
    p_org: input.organizationId,
    p_actor: input.actorUserId,
    p_operation: input.operationId,
    p_connection: input.connectionId,
    p_generation: input.generation,
    p_outcome: input.outcome,
  });
  if (error || !data) throw channelDatabaseError(error);
  const result = data as {
    held: boolean;
    current: boolean;
    connection: Record<string, unknown> | null;
  };
  return {
    held: result.held === true,
    current: result.current === true,
    connection: result.connection ? publicRow(result.connection) : null,
  };
}

/** Clears the connection (audited) under the operation's disconnect lease. */
export async function disconnectAccount(
  organizationId: string,
  actorUserId: string,
  connectionId: string,
  operationId: string,
): Promise<ChannelConnectionRow> {
  const { data, error } = await db
    .rpc("disconnect_channel_account", {
      p_org: organizationId,
      p_actor: actorUserId,
      p_connection: connectionId,
      p_operation: operationId,
    })
    .single();
  if (error || !data) throw channelDatabaseError(error);
  return publicRow(first(data));
}

/**
 * The bot's live connection in ANY organization — its id, organization and
 * current webhook generation only (never a credential). Used under the bot's
 * operation lease to derive what Telegram should hold.
 */
export async function findLiveConnectionForBot(externalAccountId: string): Promise<{
  id: string;
  organization_id: string;
  webhook_generation: string;
  webhook_secret_hash: string;
} | null> {
  const { data, error } = await db
    .from("channel_connections")
    .select("id, organization_id, webhook_generation, webhook_secret_hash")
    .eq("provider", "TELEGRAM")
    .eq("external_account_id", externalAccountId)
    .in("status", ["connected", "error"])
    .maybeSingle();
  if (error) throw channelDatabaseError(error);
  return data ?? null;
}

/** One of the organization's connections, live or not (public columns). */
export async function findConnection(
  connectionId: string,
  organizationId: string,
): Promise<ChannelConnectionRow | null> {
  const { data, error } = await db
    .from("channel_connections")
    .select(PUBLIC_COLUMNS)
    .eq("id", connectionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw channelDatabaseError(error);
  return data ? publicRow(data) : null;
}

export interface ReconcileCandidate {
  id: string;
  organization_id: string;
  external_account_id: string;
  webhook_generation: string;
  credential_ciphertext: string;
  webhook_secret_hash: string;
  reconcile_failures: number;
  /** This run's claim on the row: the fence record_channel_reconcile checks. */
  reconcile_claim: string;
}

/** Claims up to `limit` due live connections for one reconciliation run (064 §2a; SKIP LOCKED). */
export async function claimReconcileBatch(limit: number): Promise<ReconcileCandidate[]> {
  const { data, error } = await db.rpc("claim_channel_reconcile_batch", { p_limit: limit });
  if (error) throw channelDatabaseError(error);
  return (data ?? []) as ReconcileCandidate[];
}

export type ReconcileResult =
  | "healthy"
  | "repaired"
  | "missing"
  | "mismatch"
  | "unobservable"
  | "busy"
  | "stale_key"
  | "credential_unreadable";

/**
 * Records one reconciliation check for the generation the run observed —
 * only while `claim` still owns the row (fence: a lapsed or replaced claim
 * records nothing and gets `recorded: false, reason: "claim"`).
 */
export async function recordReconcile(
  connectionId: string,
  generation: string,
  claim: string,
  result: ReconcileResult,
): Promise<{
  recorded: boolean;
  reason?: "generation" | "claim";
  status?: ChannelConnectionStatus;
  last_error_code?: string | null;
  reconcile_failures?: number;
  mismatch_since?: string | null;
}> {
  const { data, error } = await db.rpc("record_channel_reconcile", {
    p_connection: connectionId,
    p_generation: generation,
    p_claim: claim,
    p_result: result,
  });
  if (error || !data) throw channelDatabaseError(error);
  return data;
}

/** A verified delivery for `generation` of a live connection: evidence of what Telegram holds (064 §2 rule 5). */
export async function observeWebhook(connectionId: string, generation: string): Promise<void> {
  const { error } = await db.rpc("observe_channel_webhook", {
    p_connection: connectionId,
    p_generation: generation,
  });
  if (error) throw channelDatabaseError(error);
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
  external_account_id: string;
  credential_ciphertext: string;
  webhook_secret_hash: string;
  webhook_generation: string;
} | null> {
  let query = db
    .from("channel_connections")
    .select(
      "id, organization_id, external_account_id, credential_ciphertext, webhook_secret_hash, webhook_generation",
    )
    .eq("id", connectionId)
    .in("status", ["connected", "error"]);
  if (organizationId) query = query.eq("organization_id", organizationId);
  const { data, error } = await query.maybeSingle();
  if (error) throw channelDatabaseError(error);
  return data ?? null;
}

/**
 * Whether Telegram update '<connection id>:<update_id>' has a committed replay
 * receipt. A LOOKUP, never a claim: the receipt is written by
 * ingest_telegram_inbound in the same transaction as the message.
 */
export async function isTelegramUpdateRecorded(eventId: string): Promise<boolean> {
  const { data, error } = await db
    .from("webhook_event_receipts")
    .select("event_id")
    .eq("provider", "telegram")
    .eq("event_id", eventId)
    .maybeSingle();
  if (error) throw channelDatabaseError(error);
  return data !== null && data !== undefined;
}

/**
 * Stores one inbound message AND its webhook replay receipt
 * ('telegram', '<connection id>:<update_id>') in one transaction.
 */
export async function ingestTelegramInbound(
  connectionId: string,
  updateId: string,
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
      p_update_id: updateId,
    })
    .single();
  if (error || !data) throw channelDatabaseError(error);
  return first(data);
}

export interface OutboundClaim {
  message: MessageRow;
  should_send: boolean;
  /** The sending attempt this claim minted; null when should_send is false. */
  attempt: string | null;
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
  /** The attempt from beginOutboundMessage; any other is refused stale_state. */
  attempt: string;
  sent: boolean;
  providerRef?: string;
  errorCode?: string;
}): Promise<MessageRow> {
  const { data, error } = await db
    .rpc("complete_outbound_message", {
      p_org: input.organizationId,
      p_message: input.messageId,
      p_connection: input.connectionId,
      p_attempt: input.attempt,
      p_sent: input.sent,
      p_provider_ref: input.providerRef ?? null,
      p_error_code: input.errorCode ?? null,
    })
    .single();
  if (error || !data) throw channelDatabaseError(error);
  return first(data);
}
