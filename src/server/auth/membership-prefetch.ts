/**
 * Request-local, single-use hand-off of an authorization context from
 * resolveActiveOrganizationId to the verifyActiveMembership that follows it.
 *
 * Every src/api/* helper does: resolveActiveOrganizationId(userId) →
 * AuthorizationService.forRequest(userId, organizationId). Both used to read
 * the same memberships row. The resolver now reads that row with its role and
 * permissions embedded, and parks the canonical one here so the verify step
 * does not read it again.
 *
 * Scope and safety — this is NOT a cache:
 *   - Stored only inside a server-function boundary, keyed by that call's own
 *     RequestContext object (a fresh object per server-function call). Nothing
 *     survives the call; nothing is shared across requests, users or orgs.
 *   - Keyed by BOTH userId and organizationId; a lookup for any other pair
 *     misses and reads the database.
 *   - Single use: taking an entry deletes it, and every resolve replaces what
 *     was parked before. A second verify in the same call (e.g. after a role
 *     change) always reads the database again.
 *   - Holds only what the database just returned for a session-derived user.
 *
 * Freshness — the one behavioral difference, accepted deliberately:
 *   The first forRequest of a call sees authority as of the resolver's read,
 *   not as of its own (formerly separate) read. A revocation or suspension
 *   that commits between those two steps of the SAME invocation is not seen
 *   by that invocation; the next invocation re-reads and sees it. This is the
 *   same class of window every invocation already had (authority is read once
 *   and held until the handler finishes); only its start moves earlier by the
 *   in-process gap between resolve and verify. There is no cross-request
 *   reuse. Tested in src/tests/authz-context-collapse.runtime.ts ("in-flight
 *   revocation window").
 */
import { currentRequestContext, type RequestContext } from "@/server/observability/request-context";
import type { MembershipContext } from "./membership";

interface Parked {
  userId: string;
  organizationId: string;
  context: MembershipContext;
}

const parked = new WeakMap<RequestContext, Parked>();

function boundaryContext(): RequestContext | undefined {
  const context = currentRequestContext();
  return context?.serverFnBoundary ? context : undefined;
}

/** Park (replacing anything parked before) or, with null, clear. */
export function parkPrefetchedMembership(
  userId: string,
  organizationId: string | null,
  context: MembershipContext | null,
): void {
  const request = boundaryContext();
  if (!request) return;
  if (!organizationId || !context) {
    parked.delete(request);
    return;
  }
  parked.set(request, { userId, organizationId, context });
}

/** Take (and remove) the parked context iff it is for exactly this pair. */
export function takePrefetchedMembership(
  userId: string,
  organizationId: string,
): MembershipContext | null {
  const request = boundaryContext();
  if (!request) return null;
  const entry = parked.get(request);
  parked.delete(request);
  if (!entry) return null;
  if (entry.userId !== userId || entry.organizationId !== organizationId) return null;
  const { membership } = entry.context;
  if (membership.user_id !== userId || membership.organization_id !== organizationId) return null;
  return entry.context;
}
