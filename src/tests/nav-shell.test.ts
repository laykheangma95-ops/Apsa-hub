/**
 * The navigation shell's plumbing: the rollback lever, tab memory, and the
 * structural promises the redesign makes about where things live.
 *
 * Source-level where the property is architectural ("Apsi is a sheet, not a
 * route"), behavioural where there is real logic to get wrong.
 *
 * Run: bun test src/tests/nav-shell.test.ts
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { featureFlagBaseline, featureFlagStorageKey, isFeatureEnabled } from "@/lib/feature-flags";
import {
  clearTabMemory,
  enforceTabMemoryPrincipal,
  readTabState,
  recallTabPath,
  recallTabScroll,
  rememberTabPath,
  rememberTabScroll,
  writeTabState,
} from "@/lib/tab-memory";
import { moveTile } from "@/lib/hub-preferences";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), "utf-8");
const exists = (rel: string) => fs.existsSync(path.resolve(ROOT, rel));

describe("NEW_NAV_BAR rollback lever", () => {
  const ENV_NAME = "VITE_NEW_NAV_BAR";
  const original = process.env[ENV_NAME];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = original;
  });

  it("ships on by default", () => {
    delete process.env[ENV_NAME];
    expect(featureFlagBaseline("NEW_NAV_BAR")).toBe(true);
  });

  it("can be rolled back from the environment without a code change", () => {
    for (const off of ["0", "false", "off", "no", "OFF"]) {
      process.env[ENV_NAME] = off;
      expect(featureFlagBaseline("NEW_NAV_BAR")).toBe(false);
      expect(isFeatureEnabled("NEW_NAV_BAR")).toBe(false);
    }
    for (const on of ["1", "true", "on", "yes"]) {
      process.env[ENV_NAME] = on;
      expect(featureFlagBaseline("NEW_NAV_BAR")).toBe(true);
    }
  });

  it("ignores a value that means neither, rather than guessing", () => {
    process.env[ENV_NAME] = "maybe";
    expect(featureFlagBaseline("NEW_NAV_BAR")).toBe(true);
    process.env[ENV_NAME] = "";
    expect(featureFlagBaseline("NEW_NAV_BAR")).toBe(true);
  });

  it("namespaces its per-browser override", () => {
    expect(featureFlagStorageKey("NEW_NAV_BAR")).toBe("apsa.flag.NEW_NAV_BAR");
  });

  it("keeps both shells in the bundle so the lever has something behind it", () => {
    const source = read("src/design-system/BottomNav.tsx");
    expect(source).toContain('useFeatureFlag("NEW_NAV_BAR")');
    expect(source).toContain("<AppNavBar");
    expect(source).toContain("LegacyBottomNav");
  });
});

describe("tab memory", () => {
  afterEach(() => clearTabMemory());

  it("remembers the whole location, query string included", () => {
    rememberTabPath("inbox", "/app/inbox?status=unread");
    expect(recallTabPath("inbox")).toBe("/app/inbox?status=unread");
  });

  it("keeps each tab's filters separate", () => {
    writeTabState("inbox", "channel", "telegram");
    writeTabState("business", "catalog-status", "ARCHIVED");
    expect(readTabState("inbox", "channel")).toBe("telegram");
    expect(readTabState("business", "channel")).toBeUndefined();
    expect(readTabState("business", "catalog-status")).toBe("ARCHIVED");
  });

  it("remembers how far down a list somebody had read", () => {
    rememberTabScroll("sales", 640);
    expect(recallTabScroll("sales")).toBe(640);
    expect(recallTabScroll("inbox")).toBe(0);
  });

  it("is dropped whole when the signed-in principal changes", () => {
    enforceTabMemoryPrincipal("user-a", "org-1");
    rememberTabPath("sales", "/app/orders/ord-1");
    writeTabState("inbox", "query", "Sokha");

    // Same principal: nothing is lost.
    enforceTabMemoryPrincipal("user-a", "org-1");
    expect(recallTabPath("sales")).toBe("/app/orders/ord-1");

    // Different person, or the same person in another organization.
    enforceTabMemoryPrincipal("user-b", "org-1");
    expect(recallTabPath("sales")).toBeUndefined();
    expect(readTabState("inbox", "query")).toBeUndefined();

    rememberTabPath("sales", "/app/orders/ord-2");
    enforceTabMemoryPrincipal("user-b", "org-2");
    expect(recallTabPath("sales")).toBeUndefined();
  });
});

describe("arranging the Sales grid", () => {
  const order = ["pos", "orders", "payments", "delivery"];

  it("moves one place at a time and keeps everything else in order", () => {
    expect(moveTile(order, "payments", -1)).toEqual(["pos", "payments", "orders", "delivery"]);
    expect(moveTile(order, "payments", 1)).toEqual(["pos", "orders", "delivery", "payments"]);
  });

  it("does nothing at the ends, and nothing for a tile that is not there", () => {
    expect(moveTile(order, "pos", -1)).toEqual(order);
    expect(moveTile(order, "delivery", 1)).toEqual(order);
    expect(moveTile(order, "nope", 1)).toEqual(order);
  });
});

describe("what is a sheet and what is a screen", () => {
  it("makes Apsi a sheet, never a route", () => {
    expect(exists("src/routes/app.apsi.tsx")).toBe(false);
    const bar = read("src/design-system/AppNavBar.tsx");
    expect(bar).toContain("<ApsiSheet");
    // The centre control opens a dialog; it does not navigate.
    expect(bar).toContain('kind === "apsi"');
  });

  it("builds the Apsi sheet on the shared BottomSheet, focused on open", () => {
    const sheet = read("src/design-system/ApsiSheet.tsx");
    expect(sheet).toContain("<BottomSheet");
    expect(sheet).toContain('snap="tall"');
    expect(sheet).toContain("inputRef.current?.focus()");
    expect(sheet).toContain("autoFocus");
  });

  it("never nests a sheet inside the Apsi sheet", () => {
    const sheet = read("src/design-system/ApsiSheet.tsx");
    expect(sheet.match(/<BottomSheet/g) ?? []).toHaveLength(1);
  });

  it("makes the hubs full screens, because they are tab roots", () => {
    expect(read("src/routes/app.sales.tsx")).toContain("<Screen");
    expect(read("src/routes/app.business.tsx")).toContain("<Screen");
  });
});

describe("migration safety", () => {
  it("redirects new-IA URLs on the server, before anything renders", () => {
    for (const file of ["src/routes/app.sales.$.tsx", "src/routes/app.business.$.tsx"]) {
      const source = read(file);
      expect(source).toContain("beforeLoad");
      expect(source).toContain("throw redirect(");
      expect(source).toContain("resolveHubDeepLink");
      expect(source).toContain("replace: true");
    }
  });

  it("puts both hubs under /app, so they inherit its auth guard", () => {
    // A hub declared anywhere else would be a signed-out-reachable screen
    // listing a merchant's business surfaces. The /app prefix is what makes
    // them children of the route that runs checkAppGuardFn in beforeLoad.
    expect(read("src/routes/app.sales.tsx")).toContain('createFileRoute("/app/sales")');
    expect(read("src/routes/app.business.tsx")).toContain('createFileRoute("/app/business")');
    const tree = read("src/routeTree.gen.ts");
    expect(tree).toMatch(
      /AppSalesRoute = AppSalesRouteImport\.update\(\{[\s\S]*?getParentRoute: \(\) => AppRoute,/,
    );
    expect(tree).toMatch(
      /AppBusinessRoute = AppBusinessRouteImport\.update\(\{[\s\S]*?getParentRoute: \(\) => AppRoute,/,
    );
  });

  it("leaves every pre-existing screen exactly where it was", () => {
    for (const route of [
      "src/routes/app.index.tsx",
      "src/routes/app.inbox.tsx",
      "src/routes/app.pos.tsx",
      "src/routes/app.orders.tsx",
      "src/routes/app.payments.tsx",
      "src/routes/app.deliveries.tsx",
      "src/routes/app.products.tsx",
      "src/routes/app.team.tsx",
      "src/routes/app.settings.tsx",
      "src/routes/app.customers.$id.tsx",
    ]) {
      expect(exists(route)).toBe(true);
    }
  });

  it("teaches the three things that moved, once", () => {
    const coach = read("src/design-system/NavCoachMarks.tsx");
    expect(coach).toContain('const STEPS = ["sales", "business", "apsi"]');
    expect(coach).toContain("apsa.coach.nav.v1");
    // It must be dismissible and must not gate the app behind itself.
    expect(coach).toContain('aria-modal="false"');
    expect(coach).toContain("appNav.coach.skip");
  });

  it("names all three coach messages in both locales", () => {
    for (const locale of ["src/locales/en.json", "src/locales/km.json"]) {
      const tree = JSON.parse(read(locale)) as {
        appNav: { coach: Record<string, { title: string; body: string }> };
      };
      for (const step of ["sales", "business", "apsi"]) {
        expect(tree.appNav.coach[step]!.title.length).toBeGreaterThan(0);
        expect(tree.appNav.coach[step]!.body.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("deep-linkable filters", () => {
  it("puts the filters the rest of the app links to in the URL", () => {
    expect(read("src/routes/app.orders.tsx")).toContain("validateSearch");
    expect(read("src/routes/app.payments.tsx")).toContain("validateSearch");
    expect(read("src/routes/app.inbox.tsx")).toContain("validateSearch");
    expect(read("src/routes/app.products.tsx")).toContain("validateSearch");
  });

  it("drops a filter value it does not recognise instead of trusting it", () => {
    const orders = read("src/routes/app.orders.tsx");
    expect(orders).toContain("ORDER_PAYMENT_FILTERS.includes");
    const payments = read("src/routes/app.payments.tsx");
    expect(payments).toContain("PAYMENT_FILTERS.some");
  });
});
