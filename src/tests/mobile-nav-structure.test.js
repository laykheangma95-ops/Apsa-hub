import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appRoute = fs.readFileSync(path.join(root, "src/routes/app.tsx"), "utf8");
const bottomNav = fs.readFileSync(path.join(root, "src/design-system/BottomNav.tsx"), "utf8");
const navConfig = fs.readFileSync(
  path.join(root, "src/design-system/mobile-nav-config.ts"),
  "utf8",
);

test("/app stays protected with beforeLoad redirects", () => {
  assert.ok(appRoute.includes("beforeLoad"));
  assert.ok(appRoute.includes("checkAppGuardFn"));
  assert.ok(appRoute.includes("throw redirect({ to: result.redirect })"));
});

test("online-seller mobile tab order stays Home Inbox Ask Sales My", () => {
  // Entries that carry permission requirements are multi-line objects now, so
  // the id may not sit on the same line as the opening brace. Order is what
  // this test is about.
  assert.match(
    navConfig,
    /tabs:\s*\[[\s\S]*HOME_TAB[\s\S]*id: "inbox"[\s\S]*ASK_TAB,[\s\S]*SALES_TAB,[\s\S]*MY_TAB,/,
  );
});

test("route groups map sales and my to existing signed-in paths", () => {
  assert.match(
    navConfig,
    /pathname\.startsWith\("\/app\/pos"\)[\s\S]*pathname\.startsWith\("\/app\/orders"\)[\s\S]*pathname\.startsWith\("\/app\/deliveries"\)/,
  );
  // My is the identity anchor: settings and the team roster, nothing else.
  assert.match(
    navConfig,
    /pathname\.startsWith\("\/app\/settings"\) \|\| pathname\.startsWith\("\/app\/team"\)\) return "my"/,
  );
});

test("the Apsi shortcuts keep an honest coming-soon state only for camera scanning", () => {
  assert.ok(navConfig.includes('id: "find-customer"'));
  assert.ok(navConfig.includes('id: "find-order"'));
  assert.ok(navConfig.includes('id: "check-payment"'));
  assert.ok(navConfig.includes('id: "track-delivery"'));
  assert.ok(navConfig.includes('id: "find-product"'));
  assert.ok(navConfig.includes('id: "check-stock"'));
  assert.ok(navConfig.includes('id: "scan-barcode"'));
  assert.ok(navConfig.includes('availability: "coming-soon"'));
});

test("the retired Resolve/More structures do not come back", () => {
  assert.ok(!navConfig.includes('id: "more"'));
  assert.ok(!navConfig.includes('id: "resolve"'));
  assert.ok(!navConfig.includes("moreGroups"));
  assert.ok(!navConfig.includes("resolveGroups"));
  assert.ok(!fs.existsSync(path.join(root, "src/design-system/ResolveSheet.tsx")));
});

test("mobile shell sizes its tab row from the visible tabs and keeps its sheets", () => {
  // The tab row is no longer a fixed five: destinations the member has no
  // server-supported access to are filtered out before it renders, so the
  // grid is sized from whatever survived.
  assert.ok(bottomNav.includes("filterBusinessNavConfig"));
  assert.ok(bottomNav.includes("gridTemplateColumns"));
  assert.ok(bottomNav.includes("config.tabs.length"));
  assert.ok(bottomNav.includes("fixed inset-x-0 bottom-0 z-50"));
  assert.ok(bottomNav.includes("<ApsiConsoleSheet"));
  assert.ok(bottomNav.includes('title={t("nav.salesSheetTitle")}'));
});

test("the Apsi console cache is partitioned at the app layout, like every other sensitive cache", () => {
  assert.ok(
    appRoute.includes("enforceApsiCachePrincipal(queryClient, session.userId, organizationId)"),
  );
});
