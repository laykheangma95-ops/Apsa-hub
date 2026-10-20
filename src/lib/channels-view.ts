/**
 * Settings → Channels: query keys and refusal copy for the Telegram connection.
 *
 * Browser-safe; no server imports. The message of a thrown server-function
 * error is the wire contract (src/lib/public-error.ts): a ChannelError's
 * message IS its code.
 */
import { isRateLimitedError } from "@/lib/public-error";

export const channelKeys = {
  /** Keyed by principal: one member's view of one organization's channels. */
  list: (userId: string, organizationId: string) =>
    ["channels", userId, organizationId, "list"] as const,
};

export type ConnectErrorKind =
  | "invalid_token"
  | "not_a_bot"
  | "account_in_use"
  | "webhook_url_unavailable"
  | "webhook_failed"
  | "connect_in_progress"
  | "connect_superseded"
  | "credential_unavailable"
  | "provider_unavailable"
  | "rate_limited"
  | "generic";

const CONNECT_CODES: ReadonlySet<string> = new Set([
  "invalid_token",
  "not_a_bot",
  "account_in_use",
  "webhook_url_unavailable",
  "webhook_failed",
  "connect_in_progress",
  "connect_superseded",
  "credential_unavailable",
  "provider_unavailable",
]);

export function classifyConnectError(error: unknown): ConnectErrorKind {
  if (isRateLimitedError(error)) return "rate_limited";
  const message = error instanceof Error ? error.message : "";
  return CONNECT_CODES.has(message) ? (message as ConnectErrorKind) : "generic";
}

/** Same shape check the server applies first; lets the form refuse a paste of the wrong thing. */
export function looksLikeTelegramToken(value: string): boolean {
  return /^[0-9]{5,20}:[A-Za-z0-9_-]{30,100}$/.test(value.trim());
}
