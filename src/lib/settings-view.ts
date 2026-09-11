/**
 * Pure, render-independent view-state logic for Settings' Business section
 * query result — pulled out of src/routes/app.settings.tsx so it is
 * directly unit-testable without rendering a component (same rationale as
 * src/lib/team-errors.ts, which this module reuses for the permission-denied
 * classification).
 *
 * Why this exists: TanStack Query v5 can report a query as neither loading
 * nor errored, with `data` still `undefined` — e.g. a paused/offline query
 * has `isPending: true, isFetching: false`, which computes to
 * `isLoading: false, isError: false`. A naive `if (isLoading) …; if
 * (isError) …; const x = query.data!;` guard chain misses that state and
 * dereferences `undefined`. resolveBusinessSectionView() is the single
 * place that decides what to render for every query state, so this can't
 * regress silently.
 */
import { isPermissionDeniedError } from "@/lib/team-errors";
import type { OrganizationProfile } from "@/api/org";

export type BusinessSectionView =
  | { kind: "loading" }
  // Cashier / Sales / Customer Service never have organization.read — the
  // Business section simply does not exist for them (not a misleading
  // "restricted" row).
  | { kind: "denied" }
  // Any other reason data isn't available: a real infra failure, or a
  // paused/offline query with data still undefined. Gets a retry affordance.
  | { kind: "error" }
  | { kind: "ready"; profile: OrganizationProfile };

export interface BusinessSectionQueryState {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  data: OrganizationProfile | undefined;
}

export function resolveBusinessSectionView(query: BusinessSectionQueryState): BusinessSectionView {
  if (query.isLoading) return { kind: "loading" };

  if (query.isError || !query.data) {
    if (query.isError && isPermissionDeniedError(query.error)) return { kind: "denied" };
    return { kind: "error" };
  }

  return { kind: "ready", profile: query.data };
}
