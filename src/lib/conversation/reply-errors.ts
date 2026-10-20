/**
 * Composer reply outcomes → the copy the Conversation screen shows.
 *
 * TanStack Start carries only an Error's `message` across the server-function
 * wire (src/lib/public-error.ts), so this reads the message: a ChannelError's
 * message IS its code, a rate-limit refusal starts with RATE_LIMITED_PREFIX,
 * and the principal check (CORRECTION-004) has its own fixed sentence.
 * A provider failure arrives as `deliveryError` on a successful call instead.
 *
 * Browser-safe; no server imports.
 */
import { isRateLimitedError } from "@/lib/public-error";

export type ReplyErrorKind =
  | "blocked_by_user"
  | "chat_not_found"
  | "channel_unavailable"
  | "rate_limited"
  | "principal_changed"
  /** A timeout, a lost connection or a 'send_stuck' sweep: delivery is UNKNOWN, not failed. */
  | "unconfirmed"
  /** The provider (or APSA, before sending) definitely did not deliver it. */
  | "not_delivered"
  /** The call itself failed; nothing is known about this reply. */
  | "generic";

const KNOWN: ReadonlySet<string> = new Set([
  "blocked_by_user",
  "chat_not_found",
  "channel_unavailable",
  "rate_limited",
]);

/*
 * Failures where Telegram may have accepted the message before APSA heard
 * back (a timeout, a dropped connection, a sender that died mid-send, a sweep
 * of a reply left 'sending'). None of them proves the message was NOT
 * delivered, so their copy never says "not delivered". Telegram's sendMessage
 * is not idempotent, so a retry can duplicate it.
 */
const AMBIGUOUS: ReadonlySet<string> = new Set(["provider_unavailable", "unknown", "send_stuck"]);

/** Whether a failed reply might have reached the customer anyway. */
export function replyMayHaveBeenSent(code: string | undefined): boolean {
  return code !== undefined && AMBIGUOUS.has(code);
}

const PRINCIPAL_CHANGED = /^The signed-in member or organization changed/;

/** A stored/delivery error code or a thrown error → the kind of copy to show. */
export function classifyReplyError(outcome: unknown): ReplyErrorKind {
  if (typeof outcome === "string") {
    if (KNOWN.has(outcome)) return outcome as ReplyErrorKind;
    return AMBIGUOUS.has(outcome) || outcome === "" ? "unconfirmed" : "not_delivered";
  }
  if (isRateLimitedError(outcome)) return "rate_limited";
  const message = outcome instanceof Error ? outcome.message : "";
  if (PRINCIPAL_CHANGED.test(message)) return "principal_changed";
  return KNOWN.has(message) ? (message as ReplyErrorKind) : "generic";
}
