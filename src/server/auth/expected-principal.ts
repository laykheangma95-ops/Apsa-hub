/**
 * The refuse-only initiating-principal check (CORRECTIONS.md, CORRECTION-004).
 *
 * The server derives who is acting when it HANDLES a request: the session's
 * member and that member's active organization at that moment. A client
 * request can outlive the principal that sent it — the screen lazily loads its
 * server function, then the request travels — and a member or organization
 * switch in that window (in this tab, or in another tab sharing the session)
 * used to execute member A's mutation as member B: B's permissions decided it,
 * and B became its recorded actor.
 *
 * So every protected mutation REQUIRES `expectedPrincipal` — the member and
 * organization the client STARTED the attempt as — and compares it with its
 * own derivation before anything else touches the request: before the
 * permission check, any rate-limit token, any read of the target and any
 * write. It is a precondition, never a credential: it can only REFUSE. It is
 * read in exactly this one comparison and never grants, selects, scopes or
 * attributes anything — authorization and every recorded actor and
 * organization stay the server's own derivation (`ctx`).
 *
 * FAIL CLOSED. A request without a well-formed principal is refused (428
 * `principal_required`), never let through: an absent assertion is exactly what
 * a browser bundle from before this rule sends, and treating it as "nothing to
 * check" was a bypass (independent review, PR #121). The server functions also
 * require the field in their validators, so such a request is refused before
 * the handler runs; this check is the same rule for every in-process caller.
 * A future server-initiated caller (a bank adapter, a job) has no browser
 * principal and must get its own explicit entry point — never an omitted field.
 *
 * Protected (each listed in CORRECTION-004): order creation, order lifecycle
 * transitions, order fulfillment transitions, parcel recovery and parcel
 * creation, shipping-destination edits, and payment recording, evidence,
 * verification, refund, reversal and correction.
 */
import { publicError } from "@/server/public-domain-error";

/** The member + organization a client started a mutation as. */
export interface ExpectedPrincipal {
  userId: string;
  organizationId: string;
}

function isExpectedPrincipal(value: unknown): value is ExpectedPrincipal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2) return false;
  const { userId, organizationId } = value as Record<string, unknown>;
  return (
    typeof userId === "string" &&
    userId.length > 0 &&
    typeof organizationId === "string" &&
    organizationId.length > 0
  );
}

/**
 * Refuse a mutation whose initiating principal is missing, malformed, or not
 * the one handling it. Neither refusal carries anything about either principal.
 */
export function assertExpectedPrincipal(
  actual: { userId: string; organizationId: string },
  expected: ExpectedPrincipal,
): void {
  if (!isExpectedPrincipal(expected)) {
    throw publicError(
      "This request did not say who started it — reload the page and try again",
      428,
      "principal_required",
    );
  }
  if (expected.userId === actual.userId && expected.organizationId === actual.organizationId) {
    return;
  }
  throw publicError(
    "The signed-in member or organization changed before this request was sent",
    409,
    "principal_changed",
  );
}
