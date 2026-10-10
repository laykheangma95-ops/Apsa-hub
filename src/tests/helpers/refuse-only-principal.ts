/**
 * The ONE sanctioned crossing of a member/organization identity into the
 * protected order, fulfillment and payment mutations: the REQUIRED, refuse-only
 * `expectedPrincipal` (CORRECTIONS.md, CORRECTION-004) — order creation (POS
 * checkout, Orders → New Order, Inbox → Prepare Order), order lifecycle and
 * fulfillment transitions, parcel recovery / creation, shipping-destination
 * edits, and payment recording, evidence, verification, refund, reversal and
 * correction. The client spells the shape once (src/lib/initiating-principal.ts)
 * and every adapter names that type.
 *
 * The invariant tests forbid any tenant or actor field on the client → server
 * order and payment paths, because such a field could be mistaken for
 * authorization. This precondition is not one: the server derives the acting
 * principal from the session and the member's active organization exactly as
 * before, and the assertion can only REFUSE a request whose initiating
 * principal is not the one handling it (src/server/auth/expected-principal.ts).
 *
 * So the invariant tests strip exactly these snippets — each must be present
 * exactly once, or the strip itself fails — and then assert the invariant over
 * what remains, unchanged. Any OTHER organizationId / userId on those paths, or
 * a second copy of one of these, still fails them.
 */
import { expect } from "bun:test";

/**
 * src/api/orders.ts AND src/api/payments.ts — the one schema each file's
 * protected validators share (`expectedPrincipal: expectedPrincipalSchema`).
 */
export const SANCTIONED_ORDER_FN_SCHEMA = `const expectedPrincipalSchema = z
  .object({ userId: z.string().uuid(), organizationId: z.string().uuid() })
  .strict();`;
export const SANCTIONED_PAYMENT_FN_SCHEMA = SANCTIONED_ORDER_FN_SCHEMA;

/** src/lib/api/index.ts — CreateRealOrderInput (required: no caller can omit it). */
export const SANCTIONED_CREATE_INPUT_FIELD = `principal: InitiatingPrincipal;`;

/** src/lib/api/index.ts — RecordRealPaymentInput (required: no caller can omit it). */
export const SANCTIONED_PAYMENT_INPUT_FIELD = `principal: InitiatingPrincipal;`;

/**
 * src/components/pos/PosCheckoutSheet.tsx — completeReal: the attempt's one
 * principal, sent with both its create and its confirm.
 */
export const SANCTIONED_POS_ATTEMPT_PRINCIPAL = `const principal = { userId: token.userId, organizationId: token.organizationId };`;

/** src/components/orders/CreateRealOrderSheet.tsx — submit's createRealOrder call (the attempt's token). */
export const SANCTIONED_NEW_ORDER_CALL_ARG = `principal: { userId: token.userId, organizationId: token.organizationId },`;

/** src/components/inbox/PrepareOrderSheet.tsx — submit's createRealOrder call (the replay scope's principal). */
export const SANCTIONED_INBOX_CALL_ARG = `principal: { userId, organizationId },`;

/**
 * The principal a test context would have STARTED a request as — what a real
 * screen sends for the member it shows. Direct service calls pass it so they
 * meet the required, refuse-only check exactly as a screen request does; it
 * changes nothing about what the call is then authorized or attributed as.
 */
export function principalOf(ctx: { userId: string; organizationId: string }): {
  userId: string;
  organizationId: string;
} {
  return { userId: ctx.userId, organizationId: ctx.organizationId };
}

/** `source` with `snippet` removed — which must occur in it exactly once. */
export function withoutSanctioned(source: string, snippet: string): string {
  const normalized = source.replace(/\r\n/g, "\n");
  const count = normalized.split(snippet).length - 1;
  expect(count).toBe(1);
  return normalized.replace(snippet, "");
}
