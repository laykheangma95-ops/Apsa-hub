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
 * So the protected mutations accept `expectedPrincipal` — the member and
 * organization the client STARTED the attempt as — and compare it with their
 * own derivation before anything else touches the request: before the
 * permission check, any rate-limit token, any read of the target and any
 * write. It is a precondition, never a credential: it can only REFUSE. It is
 * read in exactly this one comparison and never grants, selects, scopes or
 * attributes anything — authorization and every recorded actor and
 * organization stay the server's own derivation (`ctx`).
 *
 * Protected today (each documented in CORRECTION-004): order creation
 * (createOrder), order lifecycle transitions (transitionLifecycleStatus —
 * confirm, cancel, complete) and payment recording (recordPayment).
 */
import { publicError } from "@/server/public-domain-error";

/** The member + organization a client started a mutation as. */
export interface ExpectedPrincipal {
  userId: string;
  organizationId: string;
}

/**
 * Refuse a mutation whose initiating principal is not the one handling it.
 * Absent `expected` skips only this check (an older client); a mismatch is a
 * 409 with its own code, carrying nothing about either principal.
 */
export function assertExpectedPrincipal(
  actual: { userId: string; organizationId: string },
  expected: ExpectedPrincipal | undefined,
): void {
  if (!expected) return;
  if (expected.userId === actual.userId && expected.organizationId === actual.organizationId) {
    return;
  }
  throw publicError(
    "The signed-in member or organization changed before this request was sent",
    409,
    "principal_changed",
  );
}
