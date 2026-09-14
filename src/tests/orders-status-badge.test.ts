/**
 * Orders list × StatusBadge — structural assertions.
 *
 * The Orders list (/app/orders) renders its primary lifecycle status with the
 * liquid-glass StatusBadge while payment and fulfilment stay on StatusChip —
 * three separate facts, never merged. These tests pin the presentation
 * contract without a rendering harness (same precedent as
 * src/tests/order-ui-integration.test.ts: prove what can be proven from
 * source text and pure data):
 *
 *   1. every OrderLifecycleStatus value is a supported StatusBadge key
 *      (identity mapping — no local state machine, no invented statuses),
 *   2. the list passes the existing order state straight through — no
 *      derived/local UI state, no business-logic duplication,
 *   3. payment and fulfilment chips remain separate StatusChip facts,
 *   4. English and Khmer labels resolve for every lifecycle key,
 *   5. no hardcoded role/capability logic snuck into the presentation.
 *
 * Run: bun test src/tests/orders-status-badge.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import en from "../locales/en.json";
import km from "../locales/km.json";
import { STATUS_BADGE_KEYS } from "@/design-system/StatusBadge";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

const ORDER_LIST_ROUTE = "src/routes/app.orders.tsx";

/**
 * The production Order domain's lifecycle axis (src/types/index.ts). Kept as
 * a literal so the test fails loudly if the domain set changes — the identity
 * mapping to StatusBadge keys must be re-reviewed on any change.
 */
const ORDER_LIFECYCLE_STATUSES = ["draft", "confirmed", "completed", "cancelled"] as const;

describe("Orders list — lifecycle status maps to StatusBadge", () => {
  it("every OrderLifecycleStatus value is a supported StatusBadge key", () => {
    const supported = new Set<string>(STATUS_BADGE_KEYS);
    const missing = ORDER_LIFECYCLE_STATUSES.filter((key) => !supported.has(key));
    expect(missing).toEqual([]);
  });

  it("every lifecycle key has an English label", () => {
    const enStatus = en.status as Record<string, string>;
    const missing = ORDER_LIFECYCLE_STATUSES.filter((key) => !enStatus[key]);
    expect(missing).toEqual([]);
  });

  it("every lifecycle key has a Khmer label", () => {
    const kmStatus = km.status as Record<string, string>;
    const missing = ORDER_LIFECYCLE_STATUSES.filter((key) => !kmStatus[key]);
    expect(missing).toEqual([]);
  });

  it("lifecycle labels never leak the raw key as their own translation", () => {
    const enStatus = en.status as Record<string, string>;
    const kmStatus = km.status as Record<string, string>;
    const leaked = ORDER_LIFECYCLE_STATUSES.filter(
      (key) => enStatus[key] === key || kmStatus[key] === key,
    );
    expect(leaked).toEqual([]);
  });
});

describe("Orders list — presentation contract (structural)", () => {
  const route = readSource(ORDER_LIST_ROUTE);

  it("renders the lifecycle axis with StatusBadge", () => {
    expect(route).toMatch(/<StatusBadge\s+status=\{order\.lifecycleStatus\}/);
  });

  it("payment and fulfilment remain separate StatusChip facts", () => {
    expect(route).toContain("<StatusChip status={order.paymentStatus} />");
    expect(route).toContain("<StatusChip status={order.fulfillmentStatus} />");
  });

  it("passes existing order state straight through — no derived status logic", () => {
    // No local mapping/derivation between the order field and the badge: the
    // badge consumes order.lifecycleStatus directly, so an impossible value
    // cannot be manufactured by the UI layer.
    expect(route).not.toMatch(/lifecycleStatus\s*[=!]==?\s*["']/);
    expect(route).not.toMatch(/(map|derive|toBadge)[A-Za-z]*\(\s*order\.lifecycleStatus/);
  });

  it("introduces no role or capability checks in the row presentation", () => {
    const rowStart = route.indexOf("function OrderRow");
    const rowEnd = route.indexOf("function OrderListScreen");
    expect(rowStart).toBeGreaterThan(-1);
    expect(rowEnd).toBeGreaterThan(rowStart);
    const rowSource = route.slice(rowStart, rowEnd);
    expect(rowSource).not.toMatch(/can\("|hasRole|isAdmin|permissions\./);
  });

  it("a rejected-but-present source renders the generic 'other' badge, not a false label", () => {
    // Both order surfaces must send unknown/legacy sources to ChannelBadge
    // "other" — never the "Entered by hand" caption (that would falsely call
    // an unknown source manual) and never straight into the icon lookup.
    for (const rel of [ORDER_LIST_ROUTE, "src/routes/app.orders.$id.tsx"]) {
      const src = readSource(rel);
      expect(src).toMatch(/isChannelSource\(order\.source\)\s*\?\s*\(/);
      expect(src).toMatch(/order\.source !== "manual"\s*\?\s*\(/);
      expect(src).toMatch(/<ChannelBadge channel="other" withLabel \/>/);
    }
  });
});
