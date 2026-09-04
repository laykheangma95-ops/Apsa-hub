import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appRoute = fs.readFileSync(path.join(root, "src/routes/app.tsx"), "utf8");
const bottomNav = fs.readFileSync(path.join(root, "src/design-system/BottomNav.tsx"), "utf8");
const navConfig = fs.readFileSync(path.join(root, "src/design-system/mobile-nav-config.ts"), "utf8");

test("/app stays protected with beforeLoad redirects", () => {
  assert.ok(appRoute.includes("beforeLoad"));
  assert.ok(appRoute.includes("checkAppGuardFn"));
  assert.ok(appRoute.includes('throw redirect({ to: result.redirect })'));
});

test("online-seller mobile tab order stays Home Inbox Resolve Sales More", () => {
  assert.match(
    navConfig,
    /tabs:\s*\[\s*\{ id: "home"[\s\S]*\{ id: "inbox"[\s\S]*\{ id: "resolve"[\s\S]*\{ id: "sales"[\s\S]*\{ id: "more"/,
  );
});

test("route groups map sales and more to existing signed-in paths", () => {
  assert.match(
    navConfig,
    /pathname\.startsWith\("\/app\/pos"\)[\s\S]*pathname\.startsWith\("\/app\/orders"\)[\s\S]*pathname\.startsWith\("\/app\/deliveries"\)/,
  );
  assert.match(
    navConfig,
    /pathname\.startsWith\("\/app\/team"\)[\s\S]*pathname\.startsWith\("\/app\/customers"\)/,
  );
});

test("resolve and sales sheets keep honest coming-soon states for missing hubs", () => {
  assert.ok(navConfig.includes('id: "scan-barcode"'));
  assert.ok(navConfig.includes('id: "find-order"'));
  assert.ok(navConfig.includes('id: "check-payment"'));
  assert.ok(navConfig.includes('id: "track-delivery"'));
  assert.ok(navConfig.includes('id: "payments"'));
  assert.ok(navConfig.includes('id: "delivery"'));
  assert.ok(navConfig.includes('id: "returns-refunds"'));
  assert.ok(navConfig.includes('availability: "coming-soon"'));
});

test("mobile shell renders a fixed five-tab navigation and bottom sheets", () => {
  assert.ok(bottomNav.includes("grid-cols-5"));
  assert.ok(bottomNav.includes("fixed inset-x-0 bottom-0 z-50"));
  assert.ok(bottomNav.includes('title={t("nav.resolveSheetTitle")}'));
  assert.ok(bottomNav.includes('title={t("nav.salesSheetTitle")}'));
  assert.ok(bottomNav.includes('title={t("nav.moreSheetTitle")}'));
});
