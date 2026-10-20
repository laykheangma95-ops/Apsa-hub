/**
 * The Telegram webhook route, dependency-free so src/server.ts can match it
 * without loading the channel domain on every request.
 */
export const TELEGRAM_WEBHOOK_PATH_PREFIX = "/api/webhooks/telegram/";

export function isTelegramWebhookRequest(request: Request): boolean {
  try {
    return new URL(request.url).pathname.startsWith(TELEGRAM_WEBHOOK_PATH_PREFIX);
  } catch {
    return false;
  }
}
