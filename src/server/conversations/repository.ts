/**
 * Conversation repository — raw DB operations.
 *
 * All functions:
 *   - Accept organizationId from a server-validated auth context (never from the client).
 *   - Filter every query by organization_id so RLS + application code are both layered.
 *   - Use supabaseAdmin (service-role) so writes can bypass RLS where the application
 *     layer has already performed authorization; RLS remains as defense-in-depth.
 *
 * supabaseAdmin is cast to `any` for the new conversation tables because the
 * hand-authored types in src/lib/supabase/types.ts predate migrations 031-033.
 * After the migrations are applied to the live project and
 * `supabase gen types typescript` is run, these casts can be removed —
 * same convention as src/server/customers/repository.ts.
 *
 * Never import this file from browser-bundled code.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type {
  ConversationRow,
  ConversationProvider,
  ConversationStatusRow,
  MessageRow,
  MessageDirectionRow,
  MessageSenderType,
  MessageContentType,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any;

// ── Conversations ─────────────────────────────────────────────────────────────

export interface ListConversationsOptions {
  status?: ConversationStatusRow;
  provider?: ConversationProvider;
  /** Matches on last_message_preview only — customer name/phone matching is done by the service layer. */
  previewQuery?: string;
  /** Restrict to conversations linked to one of these customer ids (used by search). */
  customerIds?: string[];
  limit?: number;
  /** Opaque cursor from a previous page's nextCursor. */
  cursor?: string;
}

export interface ConversationPage {
  rows: ConversationRow[];
  nextCursor: string | null;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function encodeCursor(row: ConversationRow): string {
  return Buffer.from(`${row.last_message_at}|${row.id}`, "utf8").toString("base64url");
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(\+\d{2}:?\d{2}|Z)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cursors are opaque to the caller but their DECODED content is interpolated
 * into a raw PostgREST `.or()` filter string below — a client could hand back
 * an arbitrary base64 payload, not necessarily one this server produced. Only
 * accept a decoded value that looks like the (timestamp, uuid) pair
 * encodeCursor actually produces; anything else is treated as "no cursor"
 * rather than trusted into a filter string.
 */
function decodeCursor(cursor: string): { lastMessageAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.lastIndexOf("|");
    if (sep === -1) return null;
    const lastMessageAt = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    if (!ISO_TIMESTAMP_RE.test(lastMessageAt) || !UUID_RE.test(id)) return null;
    return { lastMessageAt, id };
  } catch {
    return null;
  }
}

/**
 * Escapes a free-text search term for safe interpolation into a PostgREST
 * `.or()` filter expression, where `,`, `(`, `)` are structural syntax (they
 * separate/group conditions) — an unescaped one could let a caller inject an
 * additional filter clause into their own already-authorized query. This is
 * NOT a tenant-isolation bypass (every call site here still ANDs in the
 * server-derived organization_id filter), but input should never be trusted
 * into a raw filter string regardless.
 */
function escapeOrFilterValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/**
 * List conversations for one organization, newest activity first, with
 * keyset pagination on (last_message_at, id) — stable even as new messages
 * arrive between pages (see PHASE SCOPE "safe pagination").
 */
export async function listConversations(
  organizationId: string,
  opts: ListConversationsOptions = {},
): Promise<ConversationPage> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);

  let query = db
    .from("conversations")
    .select("*")
    .eq("organization_id", organizationId)
    .order("last_message_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (opts.status) query = query.eq("status", opts.status);
  if (opts.provider) query = query.eq("provider", opts.provider);

  // Search matches EITHER the last-message preview OR a linked customer
  // (customerIds is pre-resolved by the service layer via name/phone match).
  // These two must combine with OR, never a separate AND'd ilike() alongside them.
  if (opts.previewQuery && opts.customerIds && opts.customerIds.length > 0) {
    const escaped = escapeOrFilterValue(opts.previewQuery);
    query = query.or(
      `last_message_preview.ilike.%${escaped}%,customer_id.in.(${opts.customerIds.join(",")})`,
    );
  } else if (opts.previewQuery) {
    query = query.ilike("last_message_preview", `%${opts.previewQuery}%`);
  } else if (opts.customerIds && opts.customerIds.length > 0) {
    query = query.in("customer_id", opts.customerIds);
  }

  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded) {
      query = query.or(
        `last_message_at.lt.${decoded.lastMessageAt},and(last_message_at.eq.${decoded.lastMessageAt},id.lt.${decoded.id})`,
      );
    }
  }

  const { data, error } = await query;
  if (error) throw new Error(`listConversations: ${(error as { message: string }).message}`);

  const rows = (data ?? []) as ConversationRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    rows: page,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

/** Counts per status for the inbox filter chips, ignoring the status filter itself. */
export async function countConversationsByStatus(
  organizationId: string,
): Promise<Record<string, number>> {
  const { data, error } = await db
    .from("conversations")
    .select("status")
    .eq("organization_id", organizationId);

  if (error)
    throw new Error(`countConversationsByStatus: ${(error as { message: string }).message}`);

  const rows = (data ?? []) as { status: ConversationStatusRow }[];
  const counts: Record<string, number> = { all: rows.length };
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}

export async function findConversationById(
  organizationId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  const { data, error } = await db
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .single();

  if (error || !data) return null;
  return data as ConversationRow;
}

export async function createConversation(
  organizationId: string,
  input: {
    provider: ConversationProvider;
    provider_conversation_id: string;
    customer_id?: string | null;
    workspace_id?: string | null;
    status?: ConversationStatusRow;
  },
): Promise<ConversationRow> {
  const { data, error } = await db
    .from("conversations")
    .insert({ organization_id: organizationId, ...input })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`createConversation: ${(error as { message?: string })?.message ?? "no data"}`);
  }
  return data as ConversationRow;
}

export async function updateConversationStatus(
  organizationId: string,
  conversationId: string,
  status: ConversationStatusRow,
): Promise<ConversationRow | null> {
  const { data, error } = await db
    .from("conversations")
    .update({ status })
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (error) throw new Error(`updateConversationStatus: ${(error as { message: string }).message}`);
  return data ? (data as ConversationRow) : null;
}

/** Idempotent: setting unread_count to 0 repeatedly is a safe no-op on repeat calls. */
export async function markConversationRead(
  organizationId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  const { data, error } = await db
    .from("conversations")
    .update({ unread_count: 0 })
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (error) throw new Error(`markConversationRead: ${(error as { message: string }).message}`);
  return data ? (data as ConversationRow) : null;
}

/** assignedUserId = null unassigns. Cross-tenant/active-membership check happens in the DB trigger (migration 031). */
export async function assignConversation(
  organizationId: string,
  conversationId: string,
  assignedUserId: string | null,
): Promise<ConversationRow | null> {
  const { data, error } = await db
    .from("conversations")
    .update({ assigned_user_id: assignedUserId })
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (error) throw new Error(`assignConversation: ${(error as { message: string }).message}`);
  return data ? (data as ConversationRow) : null;
}

// ── Messages ──────────────────────────────────────────────────────────────────

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;

/**
 * The most recent `limit` messages for a conversation, returned OLDEST FIRST
 * (matching the UI's rendering order and the intent engine's bounded-context
 * contract — see migration 032's header comment).
 */
export async function listRecentMessages(
  organizationId: string,
  conversationId: string,
  limit = DEFAULT_MESSAGE_LIMIT,
): Promise<MessageRow[]> {
  const boundedLimit = Math.min(limit, MAX_MESSAGE_LIMIT);

  const { data, error } = await db
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("organization_id", organizationId)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(boundedLimit);

  if (error) throw new Error(`listRecentMessages: ${(error as { message: string }).message}`);

  return ((data ?? []) as MessageRow[]).reverse();
}

/** Cursor lookup for keyset "load older messages" pagination — see listMessagesBefore. */
export async function findMessageCursor(
  organizationId: string,
  conversationId: string,
  messageId: string,
): Promise<{ occurredAt: string; id: string } | null> {
  const { data, error } = await db
    .from("messages")
    .select("occurred_at, id")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .eq("organization_id", organizationId)
    .single();

  if (error || !data) return null;
  return { occurredAt: data.occurred_at as string, id: data.id as string };
}

export interface MessagePage {
  rows: MessageRow[];
  /** Pass as `before` to fetch the page of messages older than this one. */
  nextBeforeId: string | null;
}

/**
 * Older-message pagination for the Conversation screen's "load earlier
 * messages" scroll-up gesture. Returned oldest-first within the page.
 */
export async function listMessagesBefore(
  organizationId: string,
  conversationId: string,
  before: { occurredAt: string; id: string } | null,
  limit = DEFAULT_MESSAGE_LIMIT,
): Promise<MessagePage> {
  const boundedLimit = Math.min(limit, MAX_MESSAGE_LIMIT);

  let query = db
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("organization_id", organizationId)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(boundedLimit + 1);

  if (before) {
    query = query.or(
      `occurred_at.lt.${before.occurredAt},and(occurred_at.eq.${before.occurredAt},id.lt.${before.id})`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(`listMessagesBefore: ${(error as { message: string }).message}`);

  const rows = (data ?? []) as MessageRow[];
  const hasMore = rows.length > boundedLimit;
  const page = hasMore ? rows.slice(0, boundedLimit) : rows;
  const oldest = page[page.length - 1];

  return {
    rows: page.reverse(),
    nextBeforeId: hasMore && oldest ? oldest.id : null,
  };
}

export async function createMessage(
  organizationId: string,
  conversationId: string,
  input: {
    direction: MessageDirectionRow;
    sender_type: MessageSenderType;
    body: string;
    sender_user_id?: string | null;
    message_type?: MessageContentType;
    provider_message_id?: string | null;
    occurred_at?: string;
    attachments?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<MessageRow> {
  const { data, error } = await db
    .from("messages")
    .insert({
      organization_id: organizationId,
      conversation_id: conversationId,
      ...input,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`createMessage: ${(error as { message?: string })?.message ?? "no data"}`);
  }
  return data as MessageRow;
}

// ── Customer display-name batch lookup (avoids N+1 in the Inbox list) ──────────

export async function findCustomerDisplayNames(
  organizationId: string,
  customerIds: string[],
): Promise<Map<string, string>> {
  if (customerIds.length === 0) return new Map();

  const { data, error } = await db
    .from("customers")
    .select("id, display_name")
    .eq("organization_id", organizationId)
    .in("id", customerIds);

  if (error) throw new Error(`findCustomerDisplayNames: ${(error as { message: string }).message}`);

  const rows = (data ?? []) as { id: string; display_name: string }[];
  return new Map(rows.map((row) => [row.id, row.display_name]));
}

/** Customer ids (org-scoped) whose name or phone matches the search query — used by conversation search. */
export async function findCustomerIdsMatching(
  organizationId: string,
  query: string,
): Promise<string[]> {
  const escaped = escapeOrFilterValue(query);
  const { data, error } = await db
    .from("customers")
    .select("id")
    .eq("organization_id", organizationId)
    .or(`display_name.ilike.%${escaped}%,primary_phone.ilike.%${escaped}%`);

  if (error) throw new Error(`findCustomerIdsMatching: ${(error as { message: string }).message}`);

  return ((data ?? []) as { id: string }[]).map((row) => row.id);
}
