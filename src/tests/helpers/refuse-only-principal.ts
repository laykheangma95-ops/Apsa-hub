/**
 * The ONE sanctioned crossing of a member/organization identity into order
 * creation: POS checkout's refuse-only `expectedPrincipal` (CORRECTIONS.md,
 * CORRECTION-004).
 *
 * The order API's invariant tests forbid any tenant or actor field on the
 * client → server order path, because such a field could be mistaken for
 * authorization. This precondition is not one: the server derives the acting
 * principal from the session and the member's active organization exactly as
 * before, and the assertion can only REFUSE a request whose initiating
 * principal is not the one handling it (assertExpectedPrincipal in
 * src/server/orders/service.ts).
 *
 * So the invariant tests strip exactly these snippets — each must be present
 * exactly once, or the strip itself fails — and then assert the invariant over
 * what remains, unchanged. Any OTHER organizationId / userId on those paths, or
 * a second copy of one of these, still fails them.
 */
import { expect } from "bun:test";

/** src/api/orders.ts — createOrderFn's validator. */
export const SANCTIONED_ORDER_FN_SCHEMA = `expectedPrincipal: z
          .object({ userId: z.string().uuid(), organizationId: z.string().uuid() })
          .optional(),`;

/** src/lib/api/index.ts — CreateRealOrderInput. */
export const SANCTIONED_CREATE_INPUT_FIELD = `principal?: { userId: string; organizationId: string };`;

/** src/components/pos/PosCheckoutSheet.tsx — completeReal's createRealOrder call. */
export const SANCTIONED_POS_CALL_ARG = `principal: { userId: token.userId, organizationId: token.organizationId },`;

/** `source` with `snippet` removed — which must occur in it exactly once. */
export function withoutSanctioned(source: string, snippet: string): string {
  const normalized = source.replace(/\r\n/g, "\n");
  const count = normalized.split(snippet).length - 1;
  expect(count).toBe(1);
  return normalized.replace(snippet, "");
}
