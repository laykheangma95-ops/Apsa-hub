/**
 * The member + organization a screen STARTED a mutation as (CORRECTIONS.md,
 * CORRECTION-004) — the screen's own server-derived route principal, captured
 * when the merchant tapped.
 *
 * Every protected mutation sends it as `expectedPrincipal`: a refuse-only
 * precondition. The server derives the acting principal from the session and
 * the member's active organization by itself, authorizes and attributes only
 * that, and refuses (writing nothing) when the request is missing this, or was
 * started as someone else — a member or organization switch, in this tab or
 * another, between the tap and the server. It is never authorization, never
 * a tenant selector and never a recorded actor.
 *
 * The one place the client spells this shape; every adapter names the type.
 */
export interface InitiatingPrincipal {
  userId: string;
  organizationId: string;
}
