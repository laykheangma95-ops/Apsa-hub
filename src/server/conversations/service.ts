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
import type { AuthorizationContext } from "@/server/auth/authorization";
import * as repo from "./repository";
import * as customerRepo from "@/server/customers/repository";
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
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  status: ConversationStatusRow;
  assignedStaffId?: string;
}

export interface ConversationMessageSummary {
  id: string;
  direction: MessageRow["direction"];
  body: string;
  at: string;
  state?: MessageStateRow;
}

export interface ConversationDetailResult extends ConversationSummary {
  messages: ConversationMessageSummary[];
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
  };
  if (row.state) summary.state = row.state;
  return summary;
}

function toConversationSummary(
  row: ConversationRow,
  customerName: string | undefined,
): ConversationSummary {
  const summary: ConversationSummary = {
    id: row.id,
    customerId: row.customer_id ?? "",
    channel: PROVIDER_TO_CHANNEL[row.provider],
    lastMessage: row.last_message_preview ?? "",
    lastMessageAt: row.last_message_at,
    unreadCount: row.unread_count,
    status: row.status,
  };
  if (customerName !== undefined) summary.customerName = customerName;
  if (row.assigned_user_id) summary.assignedStaffId = row.assigned_user_id;
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
  let customerIds: string[] | undefined;
  if (trimmedQuery) {
    customerIds = await repo.findCustomerIdsMatching(ctx.organizationId, trimmedQuery);
  }

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
  if (customerIds) params.customerIds = customerIds;
  if (input.limit !== undefined) params.limit = input.limit;
  if (input.cursor !== undefined) params.cursor = input.cursor;

  const page = await repo.listConversations(ctx.organizationId, params);

  const resolvedCustomerIds = page.rows
    .map((row) => row.customer_id)
    .filter((id): id is string => Boolean(id));
  const names = await repo.findCustomerDisplayNames(ctx.organizationId, resolvedCustomerIds);

  return {
    conversations: page.rows.map((row) =>
      toConversationSummary(row, row.customer_id ? names.get(row.customer_id) : undefined),
    ),
    nextCursor: page.nextCursor,
  };
}

export async function listConversationCounts(
  ctx: AuthorizationContext,
): Promise<Record<string, number>> {
  ctx.require("messages.read");
  return repo.countConversationsByStatus(ctx.organizationId);
}

async function requireOwnedConversation(
  ctx: AuthorizationContext,
  conversationId: string,
): Promise<ConversationRow> {
  const conversation = await repo.findConversationById(ctx.organizationId, conversationId);
  if (!conversation) {
    throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
  }
  return conversation;
}

export async function getConversationDetail(
  ctx: AuthorizationContext,
  conversationId: string,
): Promise<ConversationDetailResult> {
  ctx.require("messages.read");

  const conversation = await requireOwnedConversation(ctx, conversationId);

  const [messages, customer] = await Promise.all([
    repo.listRecentMessages(ctx.organizationId, conversationId, DETAIL_MESSAGE_WINDOW),
    conversation.customer_id
      ? customerRepo.findCustomerById(ctx.organizationId, conversation.customer_id)
      : Promise.resolve(null),
  ]);

  return {
    ...toConversationSummary(conversation, customer?.display_name),
    messages: messages.map(toMessageSummary),
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
): Promise<{ messages: ConversationMessageSummary[]; nextBeforeId: string | null }> {
  ctx.require("messages.read");
  await requireOwnedConversation(ctx, conversationId);

  let before: { occurredAt: string; id: string } | null = null;
  if (input.beforeId) {
    before = await repo.findMessageCursor(ctx.organizationId, conversationId, input.beforeId);
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
  };
}

/** Idempotent: repeat calls after the count is already 0 are a safe no-op. */
export async function markConversationRead(
  ctx: AuthorizationContext,
  conversationId: string,
): Promise<ConversationSummary> {
  ctx.require("messages.read");
  await requireOwnedConversation(ctx, conversationId);

  const updated = await repo.markConversationRead(ctx.organizationId, conversationId);
  if (!updated) {
    throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
  }

  const customerName = updated.customer_id
    ? (await customerRepo.findCustomerById(ctx.organizationId, updated.customer_id))?.display_name
    : undefined;
  return toConversationSummary(updated, customerName);
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
  ctx.require(STATUS_PERMISSION[status]);
  await requireOwnedConversation(ctx, conversationId);

  const updated = await repo.updateConversationStatus(ctx.organizationId, conversationId, status);
  if (!updated) {
    throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
  }

  const customerName = updated.customer_id
    ? (await customerRepo.findCustomerById(ctx.organizationId, updated.customer_id))?.display_name
    : undefined;
  return toConversationSummary(updated, customerName);
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

  await requireOwnedConversation(ctx, conversationId);

  const updated = await repo.assignConversation(ctx.organizationId, conversationId, assignedUserId);
  if (!updated) {
    throw Object.assign(new Error("Conversation not found"), { statusCode: 404 });
  }

  const customerName = updated.customer_id
    ? (await customerRepo.findCustomerById(ctx.organizationId, updated.customer_id))?.display_name
    : undefined;
  return toConversationSummary(updated, customerName);
}
