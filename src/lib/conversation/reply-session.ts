/**
 * Composer reply lifecycle helpers for the Conversation screen — pure, so the
 * rules the screen depends on are unit-tested (src/tests/reply-session.test.ts).
 *
 *   reconcileThreadMessages  merges the server thread with replies this screen
 *                            appended from send results. A server snapshot
 *                            fetched AFTER a reply was appended replaces it,
 *                            so a sweep's 'failed / send_stuck' (and its Retry)
 *                            becomes visible without a remount; an older
 *                            snapshot never overwrites a newer send result.
 *   hasUnresolvedOutbound    whether anything shown is still 'sending' — the
 *                            screen keeps re-reading the thread while it is.
 *   replyCompletion          what a finished send may do to the composer: clear
 *                            the draft only if it is still the text that was
 *                            sent, forget the replay key only when THAT key's
 *                            reply is terminally 'sent'.
 *   sameScope                whether a delayed result still belongs to the
 *                            member, organization, conversation and operation
 *                            that started it.
 *
 * Browser-safe; no server imports.
 */
import type { Message } from "@/types";

export interface AppendedMessage {
  message: Message;
  /** Date.now() when the send result arrived. */
  receivedAt: number;
}

/**
 * Older pages, then the server thread, then appended send results — one entry
 * per id, in that order. For an id present in both the server thread and the
 * appended list, the server row wins when the snapshot was fetched at or after
 * the append (it reflects everything the send result did, and anything after:
 * a sweep, a late completion, a retry from another tab). The screen
 * invalidates the thread right after appending, which cancels any re-read
 * already in flight, so a snapshot that STARTED before the result cannot land
 * after it and win.
 */
export function reconcileThreadMessages(
  older: readonly Message[],
  server: readonly Message[],
  serverFetchedAt: number,
  appended: readonly AppendedMessage[],
): Message[] {
  const merged = new Map<string, Message>();
  for (const message of older) merged.set(message.id, message);
  for (const message of server) merged.set(message.id, message);
  for (const entry of appended) {
    const fromServer = server.some((message) => message.id === entry.message.id);
    if (fromServer && serverFetchedAt >= entry.receivedAt) continue;
    merged.set(entry.message.id, entry.message);
  }
  return [...merged.values()];
}

export function hasUnresolvedOutbound(messages: readonly Message[]): boolean {
  return messages.some(
    (message) => message.direction === "outbound" && message.state === "sending",
  );
}

export interface ReplyCompletionInput {
  /** The text this send submitted. */
  submittedBody: string;
  /** The composer's text NOW (the member may have typed a new reply meanwhile). */
  currentDraft: string;
  /** The replay key this send used. */
  key: string;
  /** The composer's unresolved replay key NOW, if any. */
  currentKey: string | null;
  /** The stored state of the reply the server returned. */
  resultState: Message["state"];
  /** Whether the server reported the reply failed. */
  failed: boolean;
}

export interface ReplyCompletion {
  clearDraft: boolean;
  clearKey: boolean;
}

/**
 * Only a terminal 'sent' resolves a reply. 'sending' — a replay of an attempt
 * still in flight — and 'failed' keep the key, so tapping Send again with the
 * same text reuses it and can never create a second reply. Neither a newer
 * draft nor a newer key is ever discarded by an older send's completion.
 */
export function replyCompletion(input: ReplyCompletionInput): ReplyCompletion {
  const resolved = !input.failed && input.resultState === "sent";
  if (!resolved) return { clearDraft: false, clearKey: false };
  const ownKey = input.currentKey === input.key;
  return {
    clearKey: ownKey,
    clearDraft: ownKey && input.currentDraft.trim() === input.submittedBody.trim(),
  };
}

export interface OperationScope {
  userId: string;
  organizationId: string;
  /** Conversation id; "" for screens that are not about one conversation. */
  conversationId: string;
  /** Monotonic operation number on that screen. */
  operation: number;
}

export function sameScope(started: OperationScope, now: OperationScope): boolean {
  return (
    started.userId === now.userId &&
    started.organizationId === now.organizationId &&
    started.conversationId === now.conversationId &&
    started.operation === now.operation
  );
}
