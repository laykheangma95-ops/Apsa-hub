/**
 * Settings "Business" section query-state handling —
 * src/lib/settings-view.ts#resolveBusinessSectionView.
 *
 * Regression coverage for a P1 offline crash: TanStack Query v5 can report a
 * query as neither loading nor errored with `data` still `undefined` (a
 * paused/offline query has `isPending: true, isFetching: false`, which
 * computes to `isLoading: false, isError: false`). The Business section
 * previously did `if (isLoading) …; if (isError) …; const p = data!;` and
 * crashed the whole route on `p.displayName` in that state — this is the
 * only screen that currently exposes sign-out, so the crash also made
 * sign-out unreachable.
 *
 * These are genuinely behavioral checks against the actual decision
 * function the route calls — not a source-string/grep check on app.settings.tsx.
 *
 * Run: bun test src/tests/settings-business-view.test.ts
 */
import { describe, it, expect } from "bun:test";
import { resolveBusinessSectionView } from "../lib/settings-view";
import type { OrganizationProfile } from "../api/org";

const PROFILE: OrganizationProfile = {
  displayName: "Dara Coffee",
  legalName: "Dara Coffee Co., Ltd.",
  slug: "dara-coffee",
  businessType: "cafe",
  defaultCurrency: "USD",
  country: "KH",
};

describe("resolveBusinessSectionView", () => {
  it("A. paused/offline query (not loading, not errored, data undefined) resolves to a safe error state — never crashes", () => {
    const view = resolveBusinessSectionView({
      isLoading: false,
      isError: false,
      error: null,
      data: undefined,
    });
    // The defect this guards against: naive code would do `query.data!.displayName`
    // here and throw a TypeError. Confirm the resolved view carries no such risk —
    // it must be a discriminated "error" state, not a "ready" state with undefined data.
    expect(view.kind).toBe("error");
    expect(view).not.toHaveProperty("profile");
  });

  it("A2. pending-without-fetching is also safe even if `error` happens to be a truthy non-Error value", () => {
    // Defensive: confirm the decision is driven by the explicit isError flag,
    // not by truthiness of `error`, and still never yields "ready" with no data.
    const view = resolveBusinessSectionView({
      isLoading: false,
      isError: false,
      error: "stale error object from a previous render",
      data: undefined,
    });
    expect(view.kind).toBe("error");
  });

  it("B. permission-denied error (Cashier/Sales/Customer Service) resolves to 'denied' — Business section stays omitted", () => {
    const view = resolveBusinessSectionView({
      isLoading: false,
      isError: true,
      error: new Error("Missing permission: organization.read"),
      data: undefined,
    });
    expect(view.kind).toBe("denied");
  });

  it("B2. a real infra failure (not permission-denied) resolves to 'error', not silently omitted", () => {
    const view = resolveBusinessSectionView({
      isLoading: false,
      isError: true,
      error: new Error("listOrganizationProfile: connection reset"),
      data: undefined,
    });
    expect(view.kind).toBe("error");
  });

  it("C. normal successful data resolves to 'ready' with the profile attached", () => {
    const view = resolveBusinessSectionView({
      isLoading: false,
      isError: false,
      error: null,
      data: PROFILE,
    });
    expect(view).toEqual({ kind: "ready", profile: PROFILE });
  });

  it("loading state takes priority over any error/data combination", () => {
    const view = resolveBusinessSectionView({
      isLoading: true,
      isError: false,
      error: null,
      data: undefined,
    });
    expect(view.kind).toBe("loading");
  });
});
