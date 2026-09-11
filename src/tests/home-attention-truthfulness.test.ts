/**
 * Home never claims a clean zero-attention state it cannot stand behind.
 *
 * "Nothing currently needs attention" is a factual claim about the merchant's
 * business. It is only true when every attention section the member can reach
 * answered successfully and answered zero. A Payments read that errored, or a
 * Delivery scan that was truncated, means Home does not know — and must say
 * so instead of reassuring.
 *
 * A section the member has no permission for is the opposite case: that is a
 * normal partial view, not a failure, and it must not block a truthful clean
 * zero for the sections they can see.
 *
 * These tests drive the real decision function and resolve the real English
 * and Khmer copy, so a regression shows up as the actual reassuring sentence
 * appearing on screen — not just a key changing.
 *
 * Run: bun test src/tests/home-attention-truthfulness.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { attentionCompleteness, attentionNoticeKey } from "@/lib/home-attention";
import type { HomeSection, HomeSummary } from "@/types";

const ROOT = process.cwd();

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, relPath), "utf-8"));
}

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8").replace(/\r\n/g, "\n");
}

const EN = readJson("src/locales/en.json");
const KM = readJson("src/locales/km.json");

/** Resolves a dotted i18n key the same way the screen's t() call does. */
function copy(bundle: Record<string, unknown>, key: string): string {
  const value = key
    .split(".")
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], bundle);
  expect(typeof value).toBe("string");
  return value as string;
}

const CLEAN_ZERO_EN = copy(EN, "home.noAttention");
const CLEAN_ZERO_KM = copy(KM, "home.noAttention");

// ── Summary builders ─────────────────────────────────────────────────────────

const ZERO_ORDERS: HomeSection<{
  periodCount: number;
  awaitingPaymentCount: number;
  actionNeededCount: number;
}> = {
  status: "available",
  data: { periodCount: 0, awaitingPaymentCount: 0, actionNeededCount: 0 },
};

/** Every accessible section present, successful and at zero. */
function allZeroSummary(overrides: Partial<HomeSummary> = {}): HomeSummary {
  return {
    range: "today",
    orders: ZERO_ORDERS,
    payments: { status: "available", data: { needsReviewCount: 0 } },
    finance: { status: "available", data: { netCollectedForCreatedOrders: [] } },
    inventory: { status: "available", data: { outOfStockVariantCount: 0 } },
    delivery: { status: "available", data: { actionCount: 0 } },
    ...overrides,
  };
}

/**
 * What the screen actually puts under the attention heading, in both
 * languages — the end of the chain the merchant reads.
 */
function renderedNotice(summary: HomeSummary, attentionCount: number) {
  const key = attentionNoticeKey(summary, attentionCount);
  return {
    key,
    en: key ? copy(EN, key) : null,
    km: key ? copy(KM, key) : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// The four required cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("an incomplete attention picture never reads as a clean zero", () => {
  it("Orders and Inventory are zero but Payments errored — no clean zero claim", () => {
    const summary = allZeroSummary({ payments: { status: "error" } });

    // Orders and Inventory genuinely produced nothing, so the list is empty.
    const notice = renderedNotice(summary, 0);

    expect(attentionCompleteness(summary)).toBe("incomplete");
    expect(notice.key).toBe("home.attentionIncomplete");
    expect(notice.en).not.toBe(CLEAN_ZERO_EN);
    expect(notice.km).not.toBe(CLEAN_ZERO_KM);
    expect(notice.en).toBe(copy(EN, "home.attentionIncomplete"));
    expect(notice.km).toBe(copy(KM, "home.attentionIncomplete"));
  });

  it("Orders and Inventory are zero but Delivery was truncated — no clean zero claim", () => {
    const summary = allZeroSummary({ delivery: { status: "truncated" } });
    const notice = renderedNotice(summary, 0);

    expect(attentionCompleteness(summary)).toBe("incomplete");
    expect(notice.key).toBe("home.attentionIncomplete");
    expect(notice.en).not.toBe(CLEAN_ZERO_EN);
    expect(notice.km).not.toBe(CLEAN_ZERO_KM);
  });

  it("every accessible section completed at zero — the clean zero state appears", () => {
    const summary = allZeroSummary();
    const notice = renderedNotice(summary, 0);

    expect(attentionCompleteness(summary)).toBe("complete");
    expect(notice.key).toBe("home.noAttention");
    expect(notice.en).toBe(CLEAN_ZERO_EN);
    expect(notice.km).toBe(CLEAN_ZERO_KM);
  });

  it("a permission-denied section does not block a valid clean zero", () => {
    // A cashier with no Payments access: nothing failed, they simply cannot
    // see that section. The zero they are shown is true for what they can see.
    const summary = allZeroSummary({ payments: { status: "permission_denied" } });
    const notice = renderedNotice(summary, 0);

    expect(attentionCompleteness(summary)).toBe("complete");
    expect(notice.key).toBe("home.noAttention");
    expect(notice.en).toBe(CLEAN_ZERO_EN);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The rest of the state space
// ═══════════════════════════════════════════════════════════════════════════════

describe("every incomplete shape is treated as unknown, not as zero", () => {
  const SECTIONS = ["orders", "payments", "inventory", "delivery"] as const;

  for (const section of SECTIONS) {
    for (const status of ["error", "truncated"] as const) {
      it(`${section} = ${status} suppresses the clean zero claim`, () => {
        const summary = allZeroSummary({ [section]: { status } } as Partial<HomeSummary>);
        expect(attentionCompleteness(summary)).toBe("incomplete");
        expect(renderedNotice(summary, 0).en).not.toBe(CLEAN_ZERO_EN);
      });
    }
  }

  it("finance failing alone never suppresses a truthful clean zero", () => {
    // Finance is a period total in the overview, not queued work. Its own
    // failure line is shown separately.
    const summary = allZeroSummary({ finance: { status: "error" } });
    expect(attentionCompleteness(summary)).toBe("complete");
    expect(renderedNotice(summary, 0).key).toBe("home.noAttention");
  });

  it("a partial list still says it is partial", () => {
    const summary = allZeroSummary({
      orders: {
        status: "available",
        data: { periodCount: 3, awaitingPaymentCount: 3, actionNeededCount: 0 },
      },
      payments: { status: "error" },
    });

    // Rows are showing, so this is not a zero claim — but the list the
    // merchant is reading is still missing a section.
    expect(renderedNotice(summary, 1).key).toBe("home.attentionIncomplete");
  });

  it("a complete picture with rows shows no notice at all", () => {
    const summary = allZeroSummary({
      inventory: { status: "available", data: { outOfStockVariantCount: 4 } },
    });
    expect(renderedNotice(summary, 1).key).toBeNull();
  });

  it("no accessible attention section at all is reported as unknown, not zero", () => {
    const summary = allZeroSummary({
      orders: { status: "permission_denied" },
      payments: { status: "permission_denied" },
      inventory: { status: "permission_denied" },
      delivery: { status: "permission_denied" },
    });
    const notice = renderedNotice(summary, 0);

    expect(attentionCompleteness(summary)).toBe("unavailable");
    expect(notice.key).toBe("home.attentionUnavailable");
    expect(notice.en).not.toBe(CLEAN_ZERO_EN);
    expect(notice.km).not.toBe(CLEAN_ZERO_KM);
  });

  it("denied plus errored is still unknown, never a clean zero", () => {
    const summary = allZeroSummary({
      orders: { status: "permission_denied" },
      payments: { status: "error" },
      inventory: { status: "permission_denied" },
      delivery: { status: "permission_denied" },
    });
    expect(attentionCompleteness(summary)).toBe("incomplete");
    expect(renderedNotice(summary, 0).en).not.toBe(CLEAN_ZERO_EN);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Copy and wiring
// ═══════════════════════════════════════════════════════════════════════════════

describe("the copy and the screen are wired to the decision", () => {
  it("both new strings exist in Khmer and English and are distinct from the clean zero", () => {
    for (const key of ["home.attentionIncomplete", "home.attentionUnavailable"] as const) {
      const en = copy(EN, key);
      const km = copy(KM, key);
      expect(en.length).toBeGreaterThan(0);
      expect(km.length).toBeGreaterThan(0);
      expect(en).not.toBe(CLEAN_ZERO_EN);
      expect(km).not.toBe(CLEAN_ZERO_KM);
      // Khmer is first-class: the Khmer string is real Khmer, not the English.
      expect(km).not.toBe(en);
      expect(/[ក-៿]/.test(km)).toBe(true);
      // No hard-coded uppercase transform territory, and no clipping hints.
      expect(km).not.toContain("undefined");
    }
  });

  it("Home renders the decided notice and never hard-codes the clean zero", () => {
    const source = readSource("src/routes/app.index.tsx");
    expect(source).toContain("attentionNoticeKey(summary, attention.length)");
    expect(source).toContain("{t(noticeKey)}");
    // The reassuring sentence may only reach the screen through the decision.
    expect(source).not.toContain('t("home.noAttention")');
  });

  it("per-domain failure and truncation lines are still rendered", () => {
    const source = readSource("src/routes/app.index.tsx");
    expect(source).toContain("home.sectionState.");
    expect(source).toContain('["orders", "payments", "inventory", "delivery"]');
  });
});
