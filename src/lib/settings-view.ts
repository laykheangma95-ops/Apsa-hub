/**
 * View-state logic and the write wrapper for Settings' Business section —
 * pulled out of src/routes/app.settings.tsx so both are directly
 * unit-testable without rendering a component (same rationale as
 * src/lib/team-errors.ts, which this module reuses for the permission-denied
 * classification). Mirrors the split src/lib/catalog.ts already uses for
 * Products: pure view helpers plus thin server-function wrappers in one
 * domain-scoped file.
 *
 * Why resolveBusinessSectionView() exists: TanStack Query v5 can report a
 * query as neither loading nor errored, with `data` still `undefined` — e.g.
 * a paused/offline query has `isPending: true, isFetching: false`, which
 * computes to `isLoading: false, isError: false`. A naive `if (isLoading)
 * …; if (isError) …; const x = query.data!;` guard chain misses that state
 * and dereferences `undefined`. resolveBusinessSectionView() is the single
 * place that decides what to render for every query state, so this can't
 * regress silently.
 */
import { isPermissionDeniedError } from "@/lib/team-errors";
import type { OrganizationProfile } from "@/api/org";

/**
 * The exact React Query key for the Business section's profile read
 * (src/routes/app.settings.tsx). Exported so a successful edit can write
 * straight into this cache entry (queryClient.setQueryData) instead of only
 * invalidating and hoping the refetch lands before the sheet closes — no
 * stale business name after save.
 */
export const ORGANIZATION_PROFILE_QUERY_KEY = ["settings", "organization-profile"] as const;

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

// ── Business profile edit (Settings "Business" → Edit, Phase 1) ────────────

/**
 * Thin wrapper over updateOrganizationProfileFn — dynamically imported so
 * the server-function bundle is only pulled in by the sheet that uses it,
 * matching every other lib/* → api/* wrapper in this codebase (e.g.
 * src/lib/catalog.ts#updateCatalogCategory). Never a mock fallback: a
 * network/server failure always surfaces as a thrown error, never a fake
 * success.
 */
export async function updateBusinessProfile(input: {
  displayName: string;
  businessType: string | null;
}): Promise<OrganizationProfile> {
  const { updateOrganizationProfileFn } = await import("@/api/org");
  return updateOrganizationProfileFn({ data: input });
}

export type BusinessProfileSaveErrorKind = "denied" | "server";

/**
 * Classifies a thrown updateBusinessProfile() error into a UI copy kind.
 * Best-effort presentation only, same caveat as classifyTeamActionError /
 * classifyCatalogError: the real decision already happened server-side
 * (ctx.require("organization.update") in
 * src/server/org/update-organization-profile.ts) before this ever runs.
 * Field-level validation is caught client-side before submit (see
 * EditBusinessProfileSheet), so a validation failure that still reaches the
 * server falls into "server" rather than a third, rarely-exercised kind.
 */
export function classifyBusinessProfileSaveError(err: unknown): BusinessProfileSaveErrorKind {
  return isPermissionDeniedError(err) ? "denied" : "server";
}
