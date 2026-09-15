/**
 * Conversation (Inbox) cache identity.
 *
 * The Inbox keyed on `["conversations", status, channel, query]`, plus
 * `["conversation-counts"]` and `["conversation", id]` — filters in the key,
 * but no principal. Message previews, customer names, unread counts and
 * assignment are all in those payloads, and all of them survived a sign-out in
 * the same tab because the key a second user mounts is character-for-character
 * the key the first user filled.
 *
 * The list is an infinite query, so the leak is worse than one stale page: the
 * cached entry also carries the previous principal's `nextCursor`. Partitioning
 * the key partitions the cursor with it — a cursor minted for Organization A's
 * conversation stream can never be handed to a request made as Organization B.
 * (The server would refuse to resolve it across organizations anyway; this
 * stops it from ever being sent.)
 *
 * Partitioned by user AND organization: messages.read and messages.reply are
 * per-member grants and assignment filters differ per member, so two members
 * of one organization must not share a cache entry.
 *
 * Cache identity only — src/server/conversations/service.ts re-derives the
 * organization from the membership row and re-checks messages.* on every call.
 *
 * Safe to bundle for the browser.
 */
import { createQueryPartition } from "@/lib/query-principal";

export const CONVERSATIONS_QUERY_ROOT = "conversations";

const partition = createQueryPartition(CONVERSATIONS_QUERY_ROOT);

export const conversationKeys = {
  /**
   * Everything this principal has cached from the Conversation domain — the
   * filtered lists, the status counts and every open thread.
   *
   * The invalidation target after a read/status/assignment mutation: one call,
   * scoped to the acting principal, never reaching another user's entries.
   */
  principal: (userId: string, organizationId: string) =>
    partition.principal(userId, organizationId),
  /**
   * One filtered conversation list (an infinite query — pages and their
   * cursors live under this single entry).
   */
  list: (userId: string, organizationId: string, status: string, channel: string, search: string) =>
    [CONVERSATIONS_QUERY_ROOT, userId, organizationId, "list", status, channel, search] as const,
  /** Every filtered list this principal holds, without naming the filters. */
  lists: (userId: string, organizationId: string) =>
    [CONVERSATIONS_QUERY_ROOT, userId, organizationId, "list"] as const,
  /** Per-status counts behind the filter chips. */
  counts: (userId: string, organizationId: string) =>
    [CONVERSATIONS_QUERY_ROOT, userId, organizationId, "counts"] as const,
  /** One open thread, with its messages. */
  detail: (userId: string, organizationId: string, conversationId: string) =>
    [CONVERSATIONS_QUERY_ROOT, userId, organizationId, "detail", conversationId] as const,
};

export const CONVERSATIONS_QUERY_PREFIX = partition.prefix;
export const clearConversationQueries = partition.clear;
export const enforceConversationCachePrincipal = partition.enforce;
