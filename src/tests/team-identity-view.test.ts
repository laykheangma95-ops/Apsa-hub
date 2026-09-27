/**
 * The Team header must not collapse loading, denied and error into one blank
 * subtitle.
 *
 * PR #75 replaced the fixture shop name on the Team screen with the real
 * Organization profile, which was the right fix — but every outcome other than
 * success computed to `""` and was then passed as `subtitle={workspaceName ||
 * undefined}`, so four different situations rendered identically as nothing: the
 * read in flight, a member without `organization.read`, a read the server
 * refused, and a read that failed. A merchant on a slow connection, a Cashier
 * who may never see the business name, and a backend outage were shown the same
 * empty space.
 *
 * These tests EXECUTE resolveTeamIdentityView (src/lib/team-view.ts) over each
 * query state and assert the four outcomes are distinct and non-empty, in both
 * locales. They fail if any state goes blank again, if two states become
 * indistinguishable, or if a business name is ever invented.
 *
 * Run: bun test src/tests/team-identity-view.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import en from "../locales/en.json";
import km from "../locales/km.json";
import { TEAM_IDENTITY_SUBTITLE_KEY, resolveTeamIdentityView } from "@/lib/team-view";
import type { TeamIdentityQueryState, TeamIdentityView } from "@/lib/team-view";
import type { OrganizationProfile } from "@/api/org";

const repoRoot = path.resolve(import.meta.dir, "../..");
const code = (relative: string) =>
  fs
    .readFileSync(path.join(repoRoot, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const PROFILE: OrganizationProfile = {
  displayName: "ហាងម៉ាលី",
  legalName: "Maly Shop Co., Ltd.",
  slug: "maly-shop",
  businessType: "retail",
  defaultCurrency: "USD",
  country: "KH",
};

const state = (over: Partial<TeamIdentityQueryState> = {}): TeamIdentityQueryState => ({
  isLoading: false,
  isError: false,
  error: null,
  data: undefined,
  ...over,
});

/** The exact permission-denied message src/server/auth/authorization.ts throws. */
const deniedError = new Error("Missing permission: organization.read");

/** Resolve a translated subtitle the way src/routes/app.team.tsx does. */
function subtitle(view: TeamIdentityView, locale: Record<string, unknown>): string {
  if (view.kind === "ready") return view.organizationName;
  const key = TEAM_IDENTITY_SUBTITLE_KEY[view.kind];
  const value = key.split(".").reduce<unknown>((node, part) => {
    if (node !== null && typeof node === "object") {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, locale);
  if (typeof value !== "string") throw new Error(`missing translation: ${key}`);
  return value;
}

// ── 1. Each state resolves to its own kind ────────────────────────────────────

describe("1. the four states are distinguished", () => {
  it("loading — the read is in flight", () => {
    expect(resolveTeamIdentityView(true, state({ isLoading: true }))).toEqual({ kind: "loading" });
  });

  it("denied — no organization.read grant, so the query never runs", () => {
    /*
     * The route sets `enabled: canReadOrganization`. A disabled query in
     * TanStack Query v5 reports isLoading: false, isError: false with data
     * undefined — indistinguishable from a real failure — so this must be
     * decided by the grant before the query state is consulted.
     */
    expect(resolveTeamIdentityView(false, state())).toEqual({ kind: "denied" });
    expect(resolveTeamIdentityView(false, state({ isLoading: true }))).toEqual({ kind: "denied" });
    // Even with a cached payload present, the grant decides — no organization
    // data is surfaced without organization.read.
    expect(resolveTeamIdentityView(false, state({ data: PROFILE }))).toEqual({ kind: "denied" });
  });

  it("denied — the server refuses the read even when the snapshot allowed it", () => {
    // Server truth wins over a stale client capability snapshot.
    expect(resolveTeamIdentityView(true, state({ isError: true, error: deniedError }))).toEqual({
      kind: "denied",
    });
  });

  it("error — the read failed for any other reason", () => {
    expect(
      resolveTeamIdentityView(true, state({ isError: true, error: new Error("listOrg: timeout") })),
    ).toEqual({ kind: "error" });
  });

  it("error — a paused/offline query reporting neither loading nor error", () => {
    // isPending: true with isFetching: false computes to isLoading: false. The
    // naive guard chain fell through this case straight into data.displayName.
    expect(resolveTeamIdentityView(true, state())).toEqual({ kind: "error" });
  });

  it("ready — the real organization name, verbatim", () => {
    expect(resolveTeamIdentityView(true, state({ data: PROFILE }))).toEqual({
      kind: "ready",
      organizationName: "ហាងម៉ាលី",
    });
  });
});

// ── 2. The collapse itself ────────────────────────────────────────────────────

describe("2. no state renders a blank or duplicate subtitle", () => {
  const views: TeamIdentityView[] = [
    resolveTeamIdentityView(true, state({ isLoading: true })),
    resolveTeamIdentityView(false, state()),
    resolveTeamIdentityView(true, state({ isError: true, error: new Error("boom") })),
    resolveTeamIdentityView(true, state({ data: PROFILE })),
  ];

  it("resolves to four different kinds", () => {
    expect(views.map((view) => view.kind)).toEqual(["loading", "denied", "error", "ready"]);
  });

  for (const [name, locale] of [
    ["English", en],
    ["Khmer", km],
  ] as const) {
    it(`${name}: every state has non-empty copy`, () => {
      for (const view of views) {
        const text = subtitle(view, locale as unknown as Record<string, unknown>);
        expect(text.trim().length).toBeGreaterThan(0);
      }
    });

    it(`${name}: no two states read the same`, () => {
      // This is the assertion that fails if the negative states collapse back
      // into one another — or back into nothing.
      const texts = views.map((view) =>
        subtitle(view, locale as unknown as Record<string, unknown>),
      );
      expect(new Set(texts).size).toBe(texts.length);
    });
  }
});

// ── 3. No fabricated business name ───────────────────────────────────────────

describe("3. a business name is never invented", () => {
  it("no non-ready state carries an organization name", () => {
    for (const view of [
      resolveTeamIdentityView(true, state({ isLoading: true })),
      resolveTeamIdentityView(false, state()),
      resolveTeamIdentityView(true, state({ isError: true, error: new Error("boom") })),
    ]) {
      expect(view).not.toHaveProperty("organizationName");
    }
  });

  it("the copy for every non-ready state names no business", () => {
    // A placeholder like "Your business" or a fixture shop name would read as a
    // real identity. The fixture the header used to show was "ហាងម៉ាលី"-style
    // mock data from src/lib/mock/shop.ts.
    const shopFixture = code("src/lib/mock/shop.ts");
    for (const key of Object.values(TEAM_IDENTITY_SUBTITLE_KEY)) {
      for (const locale of [en, km]) {
        const text = key
          .split(".")
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown> | undefined)?.[part],
            locale,
          );
        expect(typeof text).toBe("string");
        expect(shopFixture).not.toContain(text as string);
      }
    }
  });

  it("a successful read with a blank name does not render as an empty subtitle", () => {
    // Unreachable through APSA's own write paths (src/lib/org-schema.ts requires
    // a non-empty displayName), but a `ready` carrying "" is exactly the silent
    // blank this fix removes.
    const blank = resolveTeamIdentityView(true, state({ data: { ...PROFILE, displayName: "  " } }));
    expect(blank.kind).not.toBe("ready");
    expect(subtitle(blank, en as unknown as Record<string, unknown>).trim().length).toBeGreaterThan(
      0,
    );
  });
});

// ── 4. The Team screen uses the helper ───────────────────────────────────────

describe("4. the Team screen delegates to the helper", () => {
  const team = code("src/routes/app.team.tsx");

  it("resolves the subtitle through resolveTeamIdentityView", () => {
    expect(team).toContain("resolveTeamIdentityView(canReadOrganization, organizationQuery)");
    expect(team).toContain("TEAM_IDENTITY_SUBTITLE_KEY[identityView.kind]");
  });

  it("no longer blanks the subtitle when the name is absent", () => {
    // `subtitle={workspaceName || undefined}` is the collapse itself.
    expect(team).not.toContain("workspaceName || undefined");
    expect(team).toContain("subtitle={workspaceName}");
  });

  it("still reads the real Organization profile behind organization.read", () => {
    // Preserved from PR #75 — no fixture workspace, no fake switcher.
    expect(team).toContain("getOrganizationProfileFn()");
    expect(team).toContain('capabilities.can("organization.read")');
    expect(team).not.toContain("@/lib/mock");
    expect(team).not.toContain("getWorkspaces");
  });
});
