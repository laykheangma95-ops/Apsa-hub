/**
 * The Telegram webhook route, dependency-free so src/server.ts can match it
 * without loading the channel domain on every request.
 */
export const TELEGRAM_WEBHOOK_PATH_PREFIX = "/api/webhooks/telegram/";

/** The scheduler's reconciliation entry (src/server/channels/reconcile.ts). */
export const CHANNEL_RECONCILE_PATH = "/api/internal/channels/reconcile";

export function isChannelReconcileRequest(request: Request): boolean {
  try {
    return new URL(request.url).pathname === CHANNEL_RECONCILE_PATH;
  } catch {
    return false;
  }
}

export function isTelegramWebhookRequest(request: Request): boolean {
  try {
    return new URL(request.url).pathname.startsWith(TELEGRAM_WEBHOOK_PATH_PREFIX);
  } catch {
    return false;
  }
}
