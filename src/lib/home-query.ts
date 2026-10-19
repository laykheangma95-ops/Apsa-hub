import type { QueryClient } from "@tanstack/react-query";
import type { CapabilityView } from "@/lib/capabilities";
import { isPermissionDeniedError } from "@/lib/team-errors";
import type { HomeSummary, MetricRange } from "@/types";

/**
 * Every authenticated Home cache entry lives under this prefix, so one
 * `removeQueries` call can drop all of it without knowing which principals,
 * organizations or ranges happen to be cached in this tab.
 */
export const HOME_QUERY_PREFIX = ["home", "authenticated"] as const;

/**
 * Home data is sensitive tenant data. Principal and organization are part of
 * its cache identity so a sign-out/sign-in or organization change cannot reuse
 * another scope's result. Neither value is trusted by the server for access.
 */
export function homeQueryKey(userId: string, organizationId: string, range: MetricRange) {
  return [...HOME_QUERY_PREFIX, userId, organizationId, range] as const;
}

/**
 * The principal whose Home data this tab's cache is currently allowed to hold.
 * Keyed by QueryClient rather than held in component state so it survives the
 * unmount/remount cycle of a client-side sign-out then sign-in, which is the
 * case where one tab serves two different users.
 */
const LAST_PRINCIPAL = new WeakMap<QueryClient, string>();

/**
 * The single place Home's cached tenant data is destroyed.
 *
 * `removeQueries` (not `invalidateQueries`) is deliberate: invalidation leaves
 * the previous principal's payload readable in the cache until a refetch
 * resolves, which is exactly the window a signed-out user's data must not
 * survive into.
 *
 * Never throws. Sign-out must complete — and the session must stay revoked —
 * even if the query cache is in a bad state.
 */
export function clearHomeQueries(queryClient: QueryClient): void {
  try {
    queryClient.removeQueries({ queryKey: HOME_QUERY_PREFIX });
  } catch {
    // A cache that cannot be pruned must never keep the user signed in.
  } finally {
    // The recorded principal goes with the data, so the next principal to
    // mount is always treated as a change and purges again.
    try {
      LAST_PRINCIPAL.delete(queryClient);
    } catch {
      // Ignore — nothing here may block sign-out.
    }
  }
}

/**
 * Drop Home's cache whenever the authenticated principal or active
 * organization differs from the one the cache was filled for, and leave it
 * alone otherwise so normal caching still works for the same principal.
 *
 * `userId` and `organizationId` must come from the server-derived route
 * context (the /app guard resolves both from the validated session and the
 * active membership row). They are a cache partition only — never an
 * authorization claim, and never read from client input.
 */
export function enforceHomeCachePrincipal(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
): void {
  // "/" cannot appear in a UUID, so no two principals can produce one string.
  const principal = `${userId}/${organizationId}`;
  if (LAST_PRINCIPAL.get(queryClient) === principal) return;
  clearHomeQueries(queryClient);
  LAST_PRINCIPAL.set(queryClient, principal);
}

// ── Financial figures: display gate and grant eviction ──────────────────────

/**
 * The keys the server's Home finance section requires (canReadFinancials in
 * src/server/home/service.ts). Mirrored here only to decide whether a figure
 * the server already returned may still be DRAWN; the server re-checks on
 * every read regardless.
 */
export const HOME_FINANCE_PERMISSIONS = ["orders.read", "payments.reconcile"] as const;

/**
 * Whether Home may draw the money it holds right now.
 *
 * - `granted`    — the capability snapshot is currently confirmed by the
 *                  server (canSensitive) AND that confirmation is recent
 *                  (useSensitiveCapabilityFreshness) AND holds every finance
 *                  key AND Home's own latest read succeeded.
 * - `denied`     — a confirmed snapshot says this member lacks a finance key.
 * - `unverified` — anything else: the snapshot is pending, its latest refresh
 *                  failed or has not answered within the freshness deadline,
 *                  the session no longer resolves to an active member, or
 *                  Home's latest read failed. A figure fetched while access
 *                  held is not evidence that it still holds.
 */
export type HomeFinanceAccess = "granted" | "denied" | "unverified";

export function resolveHomeFinanceAccess(
  capabilities: Pick<CapabilityView, "state" | "stale" | "canSensitive">,
  homeReadFailed: boolean,
  confirmationFresh: boolean,
): HomeFinanceAccess {
  const confirmed = capabilities.state === "ready" && !capabilities.stale && confirmationFresh;
  if (!confirmed) return "unverified";
  if (!HOME_FINANCE_PERMISSIONS.every((key) => capabilities.canSensitive(key))) return "denied";
  return homeReadFailed ? "unverified" : "granted";
}

/**
 * True for the exact refusals Home's read boundary throws when the caller is
 * no longer an authenticated active member with an operational read
 * (src/api/home.ts, src/server/home/service.ts) — or a transport-level 401 or
 * 403. Never a loose substring match: a database failure is a retryable
 * outage, not a revocation.
 */
export function isHomeAccessError(error: unknown): boolean {
  if (isPermissionDeniedError(error)) return true;
  if (!(error instanceof Error)) return false;
  if (error.message === "Home requires an operational read permission") return true;
  const status =
    (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  return status === 401 || status === 403;
}

/** The last finance answer each principal's Home cache was filled under. */
const LAST_FINANCE_GRANT = new WeakMap<QueryClient, Map<string, boolean>>();

/**
 * Whether Home last rendered with this principal's finance access confirmed.
 * False until it has — a read that lands before then is not to keep money.
 */
export function isHomeFinanceConfirmed(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
): boolean {
  try {
    return LAST_FINANCE_GRANT.get(queryClient)?.get(`${userId}/${organizationId}`) === true;
  } catch {
    return false;
  }
}

/**
 * Home's read result as it may be CACHED: the figures it carries are dropped
 * (as "error" — unavailable) unless finance access is confirmed at the moment
 * the response lands. So a re-read made while confirmation has lapsed keeps
 * its counts but never puts money back into memory, where a later render
 * could pick it up. The figures come back only through a read that lands
 * after confirmation returns (enforceHomeFinanceCache triggers it).
 */
export function guardHomeFinance(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
  summary: HomeSummary,
): HomeSummary {
  if (summary.finance.status !== "available") return summary;
  if (isHomeFinanceConfirmed(queryClient, userId, organizationId)) return summary;
  return { ...summary, finance: { status: "error" } };
}

/**
 * Evict this principal's Home entries — and cancel their in-flight reads — the
 * moment Home's finance access stops being confirmed, so a figure fetched
 * while it held cannot be read back out of the cache, and a response that was
 * already on the wire cannot land afterwards and restore it (a cancelled
 * query discards its result).
 *
 * Same shape as enforceCustomerSensitiveCache (src/lib/customers-query.ts):
 * call it during render, before Home's useQuery, so no frame is drawn from an
 * entry that should already be gone. A no-op while access keeps holding, and
 * again while it stays lost, so ordinary caching is untouched. Never throws;
 * the render-time gate (resolveHomeFinanceAccess) still hides the value.
 *
 * When confirmation RETURNS, entries that hold no figures — withheld by
 * guardHomeFinance, or refused/failed by the server under the old answer —
 * are re-read (their counts stay on screen meanwhile), so money comes back
 * only from a read that lands under the new confirmation. Once per return,
 * so this cannot loop.
 */
export function enforceHomeFinanceCache(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
  financeConfirmed: boolean,
): void {
  try {
    let record = LAST_FINANCE_GRANT.get(queryClient);
    if (!record) {
      record = new Map();
      LAST_FINANCE_GRANT.set(queryClient, record);
    }
    const tag = `${userId}/${organizationId}`;
    const previous = record.get(tag);
    record.set(tag, financeConfirmed);
    if (financeConfirmed) {
      if (previous === false) {
        void queryClient
          .invalidateQueries({
            queryKey: [...HOME_QUERY_PREFIX, userId, organizationId],
            predicate: (query) =>
              (query.state.data as HomeSummary | undefined)?.finance.status !== "available",
          })
          .catch(() => undefined);
      }
      return;
    }
    if (previous === false) return;
    evictHomePrincipal(queryClient, userId, organizationId);
  } catch {
    // Never block a render.
  }
}

/** Cancel and drop one principal's Home entries. Never throws. */
export function evictHomePrincipal(
  queryClient: QueryClient,
  userId: string,
  organizationId: string,
): void {
  try {
    const queryKey = [...HOME_QUERY_PREFIX, userId, organizationId];
    void queryClient.cancelQueries({ queryKey }).catch(() => undefined);
    queryClient.removeQueries({ queryKey });
  } catch {
    // Never block a render.
  }
}
