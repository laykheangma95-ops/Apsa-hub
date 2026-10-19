/**
 * The custody guard's cancellation refusal (migration 063,
 * src/server/orders/service.ts cancelBlockedToError) as it crosses the
 * server-function wire — shared by the service that writes it and the screen
 * that reads it.
 *
 * TanStack Start serializes only an Error's `message` (router-core
 * ShallowErrorPlugin; see src/lib/public-error.ts), so the error's `code` never
 * reaches the browser. The service therefore leads the message with the code,
 * as RATE_LIMITED_PREFIX does for rate limits:
 *
 *   "order_cancel_goods_with_customer: This order cannot be cancelled: …"
 *
 * Only these codes, only at the very start of the message, are recognised —
 * never the human-readable text after them.
 *
 * Safe for the browser bundle: no imports.
 */

export const ORDER_CANCEL_BLOCKED_CODES = [
  "order_cancel_goods_with_customer",
  "order_cancel_goods_dispatched",
  "order_cancel_active_delivery",
  "order_cancel_blocked",
] as const;

export type OrderCancelBlockedCode = (typeof ORDER_CANCEL_BLOCKED_CODES)[number];

/** The public message for a custody refusal: its code, then APSA-authored text. */
export function formatOrderCancelBlockedMessage(
  code: OrderCancelBlockedCode,
  text: string,
): string {
  return `${code}: ${text}`;
}

const CODE_PREFIX_RE = /^(order_cancel_[a-z_]+): /;

/** The custody refusal code a server-function error's message leads with, or null. */
export function orderCancelBlockedCodeOf(message: string): OrderCancelBlockedCode | null {
  const code = CODE_PREFIX_RE.exec(message)?.[1];
  return (ORDER_CANCEL_BLOCKED_CODES as readonly string[]).includes(code ?? "")
    ? (code as OrderCancelBlockedCode)
    : null;
}
