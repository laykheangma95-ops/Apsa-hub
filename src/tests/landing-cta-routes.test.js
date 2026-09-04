import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const landingRoute = fs.readFileSync(path.join(root, "src/routes/index.tsx"), "utf8");
const appRoute = fs.readFileSync(path.join(root, "src/routes/app.tsx"), "utf8");
const routeTree = fs.readFileSync(path.join(root, "src/routeTree.gen.ts"), "utf8");

test("all landing Start free CTAs point to /sign-up", () => {
  const matches = [...landingRoute.matchAll(/<Link to="([^"]+)"/g)].map((match) => match[1]);
  const startFreeTargets = matches.filter((target) => target === "/sign-up");

  assert.equal(startFreeTargets.length, 5);
  assert.ok(!landingRoute.includes('to="/app">{t("landing.nav.start")}'));
  assert.ok(!landingRoute.includes('to="/app" onClick={() => setMobileOpen(false)}'));
  assert.ok(!landingRoute.includes('to="/app">\n                  {t("landing.hero.primary")}'));
  assert.ok(!landingRoute.includes('to="/app">\n              {t("landing.apsi.action")}'));
  assert.ok(!landingRoute.includes('to="/app">\n              {t("landing.cta.action")}'));
});

test("the generated TanStack route tree includes /sign-up and no stale /auth auth routes", () => {
  assert.ok(routeTree.includes("import { Route as SignUpRouteImport } from './routes/sign-up'"));
  assert.ok(routeTree.includes("path: '/sign-up'"));
  assert.ok(!routeTree.includes("/auth/sign-in"));
  assert.ok(!routeTree.includes("/auth/sign-up"));
});

test("/app stays protected and still redirects unauthenticated users to /sign-in", () => {
  assert.ok(appRoute.includes('createFileRoute("/app")'));
  assert.ok(appRoute.includes('throw redirect({ to: result.redirect })'));
  assert.ok(appRoute.includes('/sign-in'));
});
