/**
 * Team cache identity.
 *
 * The Team roster is the most directly personal payload in the app after the
 * customer record: every row carries a staff member's name, their email or
 * phone, their role and their membership status (src/server/team/service.ts →
 * listTeam). It was keyed on the bare string `["team"]`, so Organization A's
 * roster was readable, unchanged, by whoever mounted /app/team next in the
 * same tab — including a member of Organization B after an account switch.
 *
 * Partitioned by user AND organization, not organization alone: team.read and
 * the role-authority rules in CORRECTIONS-001 differ between an Owner and a
 * Manager of the same organization, and the server shapes what it returns
 * accordingly.
 *
 * Cache identity only — listTeamFn re-checks team.read server-side on every
 * call, and every membership mutation re-checks its own grant plus the
 * CORRECTION-001 authority cap.
 *
 * Safe to bundle for the browser.
 */
import { createQueryPartition } from "@/lib/query-principal";

export const TEAM_QUERY_ROOT = "team";

const partition = createQueryPartition(TEAM_QUERY_ROOT);

export const teamKeys = {
  /** Everything this principal has cached from the Team domain. */
  principal: (userId: string, organizationId: string) =>
    partition.principal(userId, organizationId),
  /** The staff roster for one principal. */
  roster: (userId: string, organizationId: string) =>
    [TEAM_QUERY_ROOT, userId, organizationId, "roster"] as const,
};

export const TEAM_QUERY_PREFIX = partition.prefix;
export const clearTeamQueries = partition.clear;
export const enforceTeamCachePrincipal = partition.enforce;
