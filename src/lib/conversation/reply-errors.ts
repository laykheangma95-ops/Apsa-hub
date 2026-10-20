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
  | "generic";

const KNOWN: ReadonlySet<string> = new Set([
  "blocked_by_user",
  "chat_not_found",
  "channel_unavailable",
  "rate_limited",
]);

const PRINCIPAL_CHANGED = /^The signed-in member or organization changed/;

/** A deliveryError code or a thrown error → the kind of copy to show. */
export function classifyReplyError(outcome: unknown): ReplyErrorKind {
  if (typeof outcome === "string") {
    return KNOWN.has(outcome) ? (outcome as ReplyErrorKind) : "generic";
  }
  if (isRateLimitedError(outcome)) return "rate_limited";
  const message = outcome instanceof Error ? outcome.message : "";
  if (PRINCIPAL_CHANGED.test(message)) return "principal_changed";
  return KNOWN.has(message) ? (message as ReplyErrorKind) : "generic";
}
