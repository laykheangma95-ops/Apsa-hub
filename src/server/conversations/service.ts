/**
 * Conversation service — business logic layer.
 *
 * All public functions:
 *   1. Accept an AuthorizationContext (server-verified user + org).
 *   2. Check the required permission before touching the DB.
 *   3. Delegate raw DB operations to the repository.
 *   4. Map DB rows to the SAME shape the existing (mock) Inbox/Conversation UI
 *      already consumes (src/types/index.ts Conversation / ConversationDetail /
 *      Message) — see CLAUDE.md "Keep current UI contract where possible."
 *
 * CUSTOMER LINKAGE (reuses the existing Customer domain — never a parallel
 * identity resolver): only the non-sensitive customer display name is
 * embedded here. Sensitive fields (phone, address) stay exclusively behind
 * src/server/customers/service.ts's own customers.view_sensitive gate — the
 * Conversation screen fetches the full Customer profile through that
 * existing, already-gated path (getCustomer360Fn), not through this service.
 *
 * BOUNDED CONTEXT: getConversationDetail returns a bounded recent-message
 * window (not the full history) — exactly the "recent authorized messages"
 * the (not-yet-merged) intent engine / Smart Actions layer needs, per its own
 * bounded-context contract (src/lib/conversation/smart-actions.ts). No
 * unbounded history scan, no AI summarization here.
 *
 * Never import this file from browser-bundled code.
 */
import { ConversationError } from "./errors";
import type { AuthorizationContext } from "@/server/auth/authorization";
import * as repo from "./repository";
import type {
  ConversationProvider,
  ConversationRow,
  ConversationStatusRow,
  MessageRow,
  MessageStateRow,
} from "./types";
import type { Channel } from "@/types";

// ── Provider ↔ Channel mapping ────────────────────────────────────────────────
// Only providers with an existing UI Channel badge are supported this phase
// (see migration 031's header note) — this mapping is total by construction.

const PROVIDER_TO_CHANNEL: Record<ConversationProvider, Channel> = {
  FACEBOOK: "facebook",
  INSTAGRAM: "instagram",
  TELEGRAM: "telegram",
  WHATSAPP: "other",
  TIKTOK: "other",
  APSA_CONSUMER: "other",
};

const CHANNEL_TO_PROVIDER: Partial<Record<Channel, ConversationProvider>> = {
  facebook: "FACEBOOK",
  instagram: "INSTAGRAM",
  telegram: "TELEGRAM",
};

// ── Domain shapes (mirror src/types/index.ts Conversation / Message) ──────────

export interface ConversationSummary {
  id: string;
  /** "" when this conversation has no resolved customer yet — never guessed. */
  customerId: string;
  /** Non-sensitive display name only, present when customerId is resolved. */
  customerName?: string;
  channel: Channel;
  provider: ConversationProvider;
  providerConversationId: string;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  status: ConversationStatusRow;
  assignedStaffId?: string;
  assignedStaffName?: string;
}

export interface ConversationMessageSummary {
  id: string;
  direction: MessageRow["direction"];
  body: string;
  at: string;
  state?: MessageStateRow;
  messageType: MessageRow["message_type"];
  senderType: MessageRow["sender_type"];
  providerMessageId: string | null;
}

export interface ConversationDetailResult extends ConversationSummary {
  messages: ConversationMessageSummary[];
  nextBeforeId: string | null;
  readThroughMessageId: string | null;
}

export interface ConversationListPage {
  conversations: ConversationSummary[];
  nextCursor: string | null;
}

function toMessageSummary(row: MessageRow): ConversationMessageSummary {
  const summary: ConversationMessageSummary = {
    id: row.id,
    direction: row.direction,
    body: row.body,
    at: row.occurred_at,
    messageType: row.message_type,
    senderType: row.sender_type,
    providerMessageId: row.provider_message_id,
  };
  if (row.state) summary.state = row.state;
  return summary;
}

function toConversationSummary(
  row: ConversationRow,
  customerName: string | undefined,
  staffName?: string,
): ConversationSummary {
  const summary: ConversationSummary = {
    id: row.id,
    customerId: row.customer_id ?? "",
    channel: PROVIDER_TO_CHANNEL[row.provider],
    provider: row.provider,
    providerConversationId: row.provider_conversation_id,
    lastMessage: row.last_message_preview ?? "",
    lastMessageAt: row.last_message_at,
    unreadCount: row.unread_count,
    status: row.status,
  };
  if (customerName !== undefined) summary.customerName = customerName;
  if (row.assigned_user_id) summary.assignedStaffId = row.assigned_user_id;
  if (staffName) summary.assignedStaffName = staffName;
  return summary;
}

// ── Bounded recent-message window for Conversation detail / Smart Actions ─────
// See this file's header comment. 50 is generous enough to cover the intent
// engine's own much smaller window (5 messages / 30 minutes) with headroom
// for the merchant reading real conversational back-and-forth.
const DETAIL_MESSAGE_WINDOW = 50;

// ── Service functions ─────────────────────────────────────────────────────────

export interface ListConversationsInput {
  status?: ConversationStatusRow | "all";
  channel?: Channel | "all";
  query?: string;
  limit?: number;
  cursor?: string;
}

export async function listConversations(
  ctx: AuthorizationContext,
  input: ListConversationsInput = {},
): Promise<ConversationListPage> {
  ctx.require("messages.read");

  const trimmedQuery = input.query?.trim();
  const provider =
    input.channel && input.channel !== "all" ? CHANNEL_TO_PROVIDER[input.channel] : undefined;

  // A channel filter with no known provider mapping (e.g. "pos" — not a
  // messaging channel) can never match a conversation; return an empty page
  // rather than silently ignoring the filter.
  if (input.channel && input.channel !== "all" && !provider) {
    return { conversations: [], nextCursor: null };
  }

  const params: repo.ListConversationsOptions = {};
  if (input.status && input.status !== "all") params.status = input.status;
  if (provider) params.provider = provider;
  if (trimmedQuery) params.previewQuery = trimmedQuery;
  if (input.limit !== undefined) params.limit = input.limit;
  if (input.cursor !== undefined) params.cursor = input.cursor;

  const page = await repo.listConversations(ctx.organizationId, params, ctx.userId);

  const resolvedCustomerIds = page.rows
    .map((row) => row.customer_id)
    .filter((id): id is string => Boolean(id));
  const names = await repo.findCustomerDisplayNames(ctx.organizationId, resolvedCustomerIds);
  const staffNames = await repo.findStaffDisplayNames(
    ctx.organizationId,
    page.rows.flatMap((row) => (row.assigned_user_id ? [row.assigned_user_id] : [])),
  );

  return {
    conversations: page.rows.map((row) =>
      toConversationSummary(
        row,
        row.customer_id ? names.get(row.customer_id) : undefined,
        row.assigned_user_id ? staffNames.get(row.assigned_user_id) : undefined,
      ),
    ),
    nextCursor: page.nextCursor,
  };
}

export async function listConversationCounts(
  ctx: AuthorizationContext,
): Promise<Record<string, number>> {
  ctx.require("messages.read");
  return repo.countConversationsByStatus(ctx.organizationId, ctx.userId);
}

async function requireOwnedConversation(
  ctx: AuthorizationContext,
  conversationId: string,
): Promise<ConversationRow> {
  const conversation = await repo.findConversationById(
    ctx.organizationId,
    conversationId,
    ctx.userId,
  );
  if (!conversation) {
    throw new ConversationError("conversation_not_found");
  }
  return conversation;
}

async function summarize(
  ctx: AuthorizationContext,
  conversation: ConversationRow,
): Promise<ConversationSummary> {
  const [names, staffNames] = await Promise.all([
    repo.findCustomerDisplayNames(
      ctx.organizationId,
      conversation.customer_id ? [conversation.customer_id] : [],
    ),
    repo.findStaffDisplayNames(
      ctx.organizationId,
      conversation.assigned_user_id ? [conversation.assigned_user_id] : [],
    ),
  ]);
  return toConversationSummary(
    conversation,
    conversation.customer_id ? names.get(conversation.customer_id) : undefined,
    conversation.assigned_user_id ? staffNames.get(conversation.assigned_user_id) : undefined,
  );
}

export async function getConversationDetail(
  ctx: AuthorizationContext,
  conversationId: string,
): Promise<ConversationDetailResult> {
  ctx.require("messages.read");

  const conversation = await requireOwnedConversation(ctx, conversationId);

  const [messages, summary] = await Promise.all([
    repo.listMessagesBefore(ctx.organizationId, conversationId, null, DETAIL_MESSAGE_WINDOW),
    summarize(ctx, conversation),
  ]);

  return {
    ...summary,
    messages: messages.rows.map(toMessageSummary),
    nextBeforeId: messages.nextBeforeId,
    readThroughMessageId:
      messages.rows.reduce<import("./types").MessageRow | null>(
        (latest, row) => (!latest || row.sequence > latest.sequence ? row : latest),
        null,
      )?.id ?? null,
  };
}

export interface ListMessagesInput {
  /** Fetch the page of messages older than this message id. Omit for the first page. */
  beforeId?: string;
  limit?: number;
}

export async function listConversationMessages(
  ctx: AuthorizationContext,
  conversationId: string,
  input: ListMessagesInput = {},
): Promise<{
  messages: ConversationMessageSummary[];
  nextBeforeId: string | null;
  readThroughMessageId: string | null;
}> {
  ctx.require("messages.read");
  await requireOwnedConversation(ctx, conversationId);

  let before: { occurredAt: string; id: string } | null = null;
  if (input.beforeId) {
    before = await repo.findMessageCursor(ctx.organizationId, conversationId, input.beforeId);
    if (!before) throw new ConversationError("invalid_cursor");
  }

  const page = await repo.listMessagesBefore(
    ctx.organizationId,
    conversationId,
    before,
    input.limit,
  );

  return {
    messages: page.rows.map(toMessageSummary),
    nextBeforeId: page.nextBeforeId,
    readThroughMessageId:
      page.rows.reduce<MessageRow | null>(
        (latest, row) => (!latest || row.sequence > latest.sequence ? row : latest),
        null,
      )?.id ?? null,
  };
}

/** Idempotent: repeat calls after the count is already 0 are a safe no-op. */
export async function markConversationRead(
  ctx: AuthorizationContext,
  conversationId: string,
  messageId?: string,
): Promise<ConversationSummary> {
  ctx.require("messages.read");
  await requireOwnedConversation(ctx, conversationId);

  if (!messageId) throw new ConversationError("message_not_found");
  await repo.markConversationRead(ctx.organizationId, conversationId, ctx.userId, messageId);
  return summarize(ctx, await requireOwnedConversation(ctx, conversationId));
}

const STATUS_PERMISSION: Record<ConversationStatusRow, string> = {
  unread: "messages.reply",
  needs_reply: "messages.reply",
  waiting_customer: "messages.reply",
  order_created: "messages.reply",
  follow_up: "messages.mark_followup",
  closed: "messages.close_conversation",
};

export async function updateConversationStatus(
  ctx: AuthorizationContext,
  conversationId: string,
  status: ConversationStatusRow,
): Promise<ConversationSummary> {
  if (!STATUS_PERMISSION[status]) throw new ConversationError("invalid_reference");
  ctx.require(STATUS_PERMISSION[status]);
  ctx.require("messages.read");
  await requireOwnedConversation(ctx, conversationId);

  const updated = await repo.updateConversationStatus(ctx.organizationId, conversationId, status);
  if (!updated) {
    throw new ConversationError("conversation_not_found");
  }

  return summarize(ctx, await requireOwnedConversation(ctx, conversationId));
}

/**
 * assignedUserId = null unassigns. Assigning to yourself needs only
 * messages.reassign_self; assigning to someone else needs messages.assign —
 * matching PERMISSIONS_MATRIX.md §10's distinction between the two.
 * Cross-tenant / active-membership checks happen at the DB (migration 031's
 * trigger) — this is defense-in-depth, not the sole check.
 */
export async function assignConversation(
  ctx: AuthorizationContext,
  conversationId: string,
  assignedUserId: string | null,
): Promise<ConversationSummary> {
  if (assignedUserId === null || assignedUserId === ctx.userId) {
    ctx.require("messages.reassign_self");
  } else {
    ctx.require("messages.assign");
  }

  ctx.require("messages.read");

  const current = await requireOwnedConversation(ctx, conversationId);
  if (
    assignedUserId === null &&
    current.assigned_user_id !== null &&
    current.assigned_user_id !== ctx.userId
  )
    ctx.require("messages.assign");
  if (assignedUserId !== null && !(await repo.isActiveAssignee(ctx.organizationId, assignedUserId)))
    throw new ConversationError("invalid_assignment");
  const updated = await repo.assignConversation(
    ctx.organizationId,
    conversationId,
    assignedUserId,
    current.assigned_user_id,
  );
  if (!updated) {
    throw new ConversationError("conversation_not_found");
  }

  return summarize(ctx, await requireOwnedConversation(ctx, conversationId));
}

/** Server-only future adapter contract. Browser API intentionally exposes neither provider IDs nor Customer UUID writes. */
export async function ensureProviderConversation(
  ctx: AuthorizationContext,
  input: Parameters<typeof repo.createConversation>[1],
): Promise<ConversationSummary> {
  ctx.require("messages.reply");
  ctx.require("messages.read");
  const row = await repo.createConversation(ctx.organizationId, input);
  const resolved = await requireOwnedConversation(ctx, row.id);
  const names = await repo.findCustomerDisplayNames(
    ctx.organizationId,
    resolved.customer_id ? [resolved.customer_id] : [],
  );
  return toConversationSummary(
    resolved,
    resolved.customer_id ? names.get(resolved.customer_id) : undefined,
  );
}

export async function ingestProviderMessage(
  ctx: AuthorizationContext,
  conversationId: string,
  input: repo.IngestMessageInput,
): Promise<ConversationMessageSummary> {
  ctx.require("messages.reply");
  ctx.require("messages.read");
  await requireOwnedConversation(ctx, conversationId);
  const row = await repo.createMessage(ctx.organizationId, conversationId, {
    ...input,
    sender_user_id: input.sender_type === "staff" ? ctx.userId : null,
  });
  return toMessageSummary(row);
}
