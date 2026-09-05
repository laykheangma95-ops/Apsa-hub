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
import { ConversationError, databaseError } from "./errors";
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
  /** Bound SQL search across previews and non-sensitive customer display names. */
  previewQuery?: string;
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
 * encodeCursor actually produces; invalid input is rejected before any filter construction.
 */
function decodeCursor(cursor: string): { lastMessageAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.lastIndexOf("|");
    if (sep === -1) return null;
    const lastMessageAt = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    if (
      !ISO_TIMESTAMP_RE.test(lastMessageAt) ||
      !Number.isFinite(Date.parse(lastMessageAt)) ||
      !UUID_RE.test(id)
    )
      return null;
    return { lastMessageAt, id };
  } catch {
    return null;
  }
}

/**
 * List conversations for one organization, newest activity first, with
 * keyset pagination on (last_message_at, id) — stable even as new messages
 * arrive between pages (see PHASE SCOPE "safe pagination").
 */
export async function listConversations(
  organizationId: string,
  opts: ListConversationsOptions = {},
  userId: string,
): Promise<ConversationPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));

  let query = db
    .rpc("conversation_inbox_rows", {
      p_org: organizationId,
      p_user: userId,
      p_search: opts.previewQuery ?? null,
    })
    .select("*")
    .eq("organization_id", organizationId)
    .order("last_message_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (opts.status === "unread") query = query.gt("unread_count", 0);
  else if (opts.status) query = query.eq("status", opts.status);
  if (opts.provider) query = query.eq("provider", opts.provider);

  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (!decoded) throw new ConversationError("invalid_cursor");
    const anchor = await findConversationById(organizationId, decoded.id, userId);
    if (!anchor) throw new ConversationError("invalid_cursor");
    if (new Date(anchor.last_message_at).getTime() !== new Date(decoded.lastMessageAt).getTime())
      throw new ConversationError("stale_state");
    {
      query = query.or(
        `last_message_at.lt.${anchor.last_message_at},and(last_message_at.eq.${anchor.last_message_at},id.lt.${decoded.id})`,
      );
    }
  }

  const { data, error } = await query;
  if (error) throw databaseError(error);

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
  userId: string,
): Promise<Record<string, number>> {
  const { data, error } = await db.rpc("conversation_counts", {
    p_org: organizationId,
    p_user: userId,
  });
  if (error) throw databaseError(error);
  return data ?? {};
}

export async function findConversationById(
  organizationId: string,
  conversationId: string,
  userId: string,
): Promise<ConversationRow | null> {
  const { data, error } = await db
    .rpc("conversation_inbox_rows", { p_org: organizationId, p_user: userId })
    .select("*")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .single();

  if (error && error.code !== "PGRST116") throw databaseError(error);
  if (!data) return null;
  return (Array.isArray(data) ? data[0] : data) as ConversationRow;
}

/** Internal trusted adapter entry; never accepts a browser-provided Customer UUID. */
export async function createConversation(
  organizationId: string,
  input: {
    provider: ConversationProvider;
    provider_conversation_id: string;
    provider_identity_id?: string;
  },
): Promise<ConversationRow> {
  const { data, error } = await db.rpc("ensure_provider_conversation", {
    p_org: organizationId,
    p_provider: input.provider,
    p_reference: input.provider_conversation_id,
    p_identity: input.provider_identity_id ?? null,
  });
  if (error || !data) throw databaseError(error);
  return (Array.isArray(data) ? data[0] : data) as ConversationRow;
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

  if (error) throw databaseError(error);
  return data ? (data as ConversationRow) : null;
}

/** The browser supplies only an actually displayed message ID, never a count or timestamp. */
export async function markConversationRead(
  organizationId: string,
  conversationId: string,
  userId: string,
  messageId: string,
): Promise<void> {
  const { error } = await db.rpc("mark_conversation_read", {
    p_org: organizationId,
    p_user: userId,
    p_conversation: conversationId,
    p_message: messageId,
  });
  if (error) throw databaseError(error);
}

export async function isActiveAssignee(organizationId: string, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw databaseError(error);
  return Boolean(data);
}

/** Profile IDs are restricted by active organization membership before lookup. */
export async function findStaffDisplayNames(
  organizationId: string,
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const { data: members, error: memberError } = await db
    .from("memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .in("user_id", userIds);
  if (memberError) throw databaseError(memberError);
  if (!members?.length) return new Map();
  const { data, error } = await db
    .from("profiles")
    .select("id, display_name")
    .in(
      "id",
      members.map((member: { user_id: string }) => member.user_id),
    );
  if (error) throw databaseError(error);
  return new Map(
    (data ?? [])
      .filter((profile: { display_name: string | null }) => profile.display_name)
      .map((profile: { id: string; display_name: string }) => [profile.id, profile.display_name]),
  );
}

/** assignedUserId = null unassigns. Cross-tenant/active-membership check happens in the DB trigger (migration 031). */
export async function assignConversation(
  organizationId: string,
  conversationId: string,
  assignedUserId: string | null,
  expectedUserId: string | null,
): Promise<ConversationRow | null> {
  let query = db
    .from("conversations")
    .update({ assigned_user_id: assignedUserId })
    .eq("id", conversationId)
    .eq("organization_id", organizationId);
  query =
    expectedUserId === null
      ? query.is("assigned_user_id", null)
      : query.eq("assigned_user_id", expectedUserId);
  const { data, error } = await query.select().maybeSingle();
  if (!error && !data) throw new ConversationError("stale_state");

  if (error) throw databaseError(error);
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

  if (error) throw databaseError(error);

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

  if (error && error.code !== "PGRST116") throw databaseError(error);
  if (!data) return null;
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
  if (error) throw databaseError(error);

  const rows = (data ?? []) as MessageRow[];
  const hasMore = rows.length > boundedLimit;
  const page = hasMore ? rows.slice(0, boundedLimit) : rows;
  const oldest = page[page.length - 1];

  return {
    rows: page.reverse(),
    nextBeforeId: hasMore && oldest ? oldest.id : null,
  };
}

export interface IngestMessageInput {
  direction: MessageDirectionRow;
  sender_type: MessageSenderType;
  body: string;
  sender_user_id?: string | null;
  sender_provider_identity_id?: string | null;
  message_type?: MessageContentType;
  provider_message_id: string;
  occurred_at: string;
  attachments?: Record<string, unknown>[] | null;
}
/** Retries return the original row; conflicting reuse of a reference is stale_state. */
export async function createMessage(
  organizationId: string,
  conversationId: string,
  input: IngestMessageInput,
): Promise<MessageRow> {
  const { data, error } = await db.rpc("ingest_conversation_message", {
    p_org: organizationId,
    p_conversation: conversationId,
    p_reference: input.provider_message_id,
    p_direction: input.direction,
    p_sender: input.sender_type,
    p_body: input.body,
    p_occurred_at: input.occurred_at,
    p_sender_user: input.sender_user_id ?? null,
    p_sender_identity: input.sender_provider_identity_id ?? null,
    p_type: input.message_type ?? "text",
    p_attachments: input.attachments ?? null,
  });
  if (error || !data) throw databaseError(error);
  return (Array.isArray(data) ? data[0] : data) as MessageRow;
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

  if (error) throw databaseError(error);

  const rows = (data ?? []) as { id: string; display_name: string }[];
  return new Map(rows.map((row) => [row.id, row.display_name]));
}
