import { markPublicDomainError } from "@/server/public-domain-error";

/**
 * Codes the browser may see. The message IS the code (same convention as
 * ConversationError), so the UI maps it to localized copy and nothing about a
 * credential, a provider response or SQL ever crosses the wire.
 */
export type ChannelErrorCode =
  | "permission_denied"
  | "invalid_token" //            the token is malformed, wrong or revoked
  | "not_a_bot" //                the token belongs to something that is not a bot
  | "account_in_use" //           another APSA organization holds this bot
  | "connection_not_found"
  | "webhook_url_unavailable" //  VITE_APP_URL is not a public https origin
  | "webhook_failed" //           Telegram refused the webhook registration
  | "credential_unavailable" //   CHANNEL_CREDENTIAL_KEY missing / ciphertext unreadable
  | "channel_unavailable" //      the conversation has no live connection to reply through
  | "conversation_not_found"
  | "invalid_reference"
  | "stale_state"
  | "provider_unavailable"
  | "channel_storage_unavailable";

const STATUS: Record<ChannelErrorCode, number> = {
  permission_denied: 403,
  invalid_token: 400,
  not_a_bot: 400,
  account_in_use: 409,
  connection_not_found: 404,
  webhook_url_unavailable: 503,
  webhook_failed: 502,
  credential_unavailable: 503,
  channel_unavailable: 409,
  conversation_not_found: 404,
  invalid_reference: 400,
  stale_state: 409,
  provider_unavailable: 503,
  channel_storage_unavailable: 503,
};

export class ChannelError extends Error {
  readonly statusCode: number;
  constructor(readonly code: ChannelErrorCode) {
    super(code);
    this.name = "ChannelError";
    this.statusCode = STATUS[code];
    markPublicDomainError(this);
  }
}

const SQL_CODES: ChannelErrorCode[] = [
  "permission_denied",
  "account_in_use",
  "connection_not_found",
  "channel_unavailable",
  "conversation_not_found",
  "invalid_reference",
  "stale_state",
];

/** Maps a migration-064 RAISE to its code; anything else is opaque. Never forwards SQL text. */
export function channelDatabaseError(error: unknown): ChannelError {
  const message = String((error as { message?: unknown })?.message ?? "");
  const code = SQL_CODES.find((candidate) => message === candidate || message.endsWith(candidate));
  return new ChannelError(code ?? "channel_storage_unavailable");
}
