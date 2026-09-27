/**
 * View-state logic for the Team screen's header identity — the business name
 * under the "Team" title (src/routes/app.team.tsx).
 *
 * Pulled out of the route for the same reason as src/lib/settings-view.ts's
 * resolveBusinessSectionView() and src/lib/home-summary-view.ts's
 * resolveHomeSummaryView(): the decision is a pure function of the capability
 * snapshot and the query state, so it is directly unit-testable without
 * rendering a component (src/tests/team-identity-view.test.ts).
 *
 * Why it exists at all. The header used to compute the name like this:
 *
 *     const workspaceName = canReadOrganization ? (organizationQuery.data?.displayName ?? "") : "";
 *     <AppHeader subtitle={workspaceName || undefined} />
 *
 * Four different situations produced the identical empty subtitle: the read
 * still in flight, the member not holding `organization.read`, the read coming
 * back denied, and the read failing outright. A merchant on a slow connection,
 * a Cashier who is never allowed to see the business name, and a real backend
 * outage were shown exactly the same thing — nothing — so none of them could
 * tell what had happened or whether to wait, ask for access, or retry.
 *
 * This module keeps them distinct. It never invents a business name: there is
 * no fixture fallback and no "Your business" placeholder, which is the bug PR
 * #75 removed in the first place (the header previously read the in-memory
 * workspace fixture in src/lib/mock/shop.ts). Every state other than `ready`
 * says what is true and names no organization.
 *
 * Presentation only. `organization.read` is re-checked server-side on the read
 * itself (src/server/org/get-organization-profile.ts `ctx.require`), so a stale
 * or tampered capability snapshot cannot surface organization data — at worst
 * it picks the wrong copy for a read the server refuses anyway.
 */
import { isPermissionDeniedError } from "@/lib/team-errors";
import type { OrganizationProfile } from "@/api/org";

export type TeamIdentityView =
  /** The read is in flight. Honest "loading", never a blank or a guessed name. */
  | { kind: "loading" }
  /**
   * The member may not see the business name — either the capability snapshot
   * says so (Cashier / Sales / Customer Service never hold `organization.read`)
   * or the server-authoritative read itself came back denied.
   */
  | { kind: "denied" }
  /**
   * Any other reason no name is available: a real infra failure, or — as
   * resolveBusinessSectionView() documents for the same query — a
   * paused/offline query reporting neither loading nor error with `data` still
   * undefined.
   */
  | { kind: "error" }
  /** The read succeeded and the organization has a name. */
  | { kind: "ready"; organizationName: string };

export interface TeamIdentityQueryState {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  data: OrganizationProfile | undefined;
}

/**
 * The single place that decides what the Team header's subtitle says.
 *
 * `canReadOrganization` is checked first because the query is disabled without
 * the grant (`enabled: canReadOrganization`). A disabled query in TanStack
 * Query v5 reports `isLoading: false, isError: false` with `data` undefined —
 * indistinguishable from a genuine failure — so without this branch every
 * Cashier would be shown the error copy for a read that was never attempted.
 */
export function resolveTeamIdentityView(
  canReadOrganization: boolean,
  query: TeamIdentityQueryState,
): TeamIdentityView {
  if (!canReadOrganization) return { kind: "denied" };

  if (query.isLoading) return { kind: "loading" };

  if (query.isError || !query.data) {
    // Server truth wins over the client snapshot: a read that comes back
    // denied is "denied" even though `canReadOrganization` said otherwise.
    if (query.isError && isPermissionDeniedError(query.error)) return { kind: "denied" };
    return { kind: "error" };
  }

  const organizationName = query.data.displayName.trim();
  /*
   * A successful read with a blank display name is not reachable through
   * APSA's own write paths — both org schemas require a non-empty name
   * (src/lib/org-schema.ts: `displayName: z.string().min(1)` on create,
   * `.trim().min(1)` on update). Folded into `error` rather than returned as a
   * `ready` with an empty string, because a `ready` that renders nothing is
   * precisely the silent blank subtitle this module exists to prevent, and
   * inventing a name here is not an option.
   */
  if (!organizationName) return { kind: "error" };

  return { kind: "ready", organizationName };
}

/**
 * The i18n key each non-`ready` state shows as the header subtitle.
 *
 * Keys rather than translated strings so this module stays pure and the route
 * owns the single `t()` call. `ready` is absent on purpose: it renders the real
 * organization name verbatim and is never translated.
 *
 * Typed as a total map over the three states, so adding a state to
 * TeamIdentityView without giving it copy — the exact way this bug would come
 * back — fails typecheck rather than rendering a blank subtitle. Every value is
 * asserted to exist in both locales by src/tests/i18n-key-parity.test.ts.
 */
export const TEAM_IDENTITY_SUBTITLE_KEY: Record<
  Exclude<TeamIdentityView["kind"], "ready">,
  string
> = {
  loading: "team.identity.loading",
  denied: "team.identity.denied",
  error: "team.identity.error",
};
