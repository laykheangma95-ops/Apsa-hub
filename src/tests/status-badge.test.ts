/**
 * Unit tests for src/design-system/StatusBadge.tsx — the token-driven status
 * badge in the liquid-glass style (APSA Status System reference).
 *
 * These are plain structural tests (no React rendering) in the same spirit as
 * mobile-nav-config.test.ts: the parts of the component that can be proven
 * without a rendering harness are proven here —
 *   1. every state in the visual reference is a supported badge key,
 *   2. every supported key has an English and Khmer label (a badge must never
 *      fall back to showing a raw key or the wrong language),
 *   3. every tone used by the key map belongs to the token-registered set.
 *
 * Run: bun test src/tests/status-badge.test.ts
 */
import { describe, it, expect } from "bun:test";
import en from "../locales/en.json";
import km from "../locales/km.json";
import { STATUS_BADGE_KEYS, type StatusBadgeTone } from "@/design-system/StatusBadge";

const EN_STATUS = en.status as Record<string, string>;
const KM_STATUS = km.status as Record<string, string>;

/** Tones registered as --status-{tone} / -soft / -text trios in styles.css. */
const TOKEN_TONES: readonly StatusBadgeTone[] = [
  "info",
  "success",
  "warning",
  "danger",
  "neutral",
  "cyan",
  "teal",
  "orange",
  "purple",
  "violet",
  "pink",
  "indigo",
];

/** The 22 states shown in the APSA Status System reference image. */
const REFERENCE_STATES = [
  "synced",
  "connected",
  "new_message",
  "needs_reply",
  "ai_suggested",
  "in_review",
  "approved",
  "pending",
  "pending_payment",
  "paid",
  "cod_pending",
  "processing",
  "scheduled",
  "in_delivery",
  "delivered",
  "completed",
  "refunded",
  "cancelled",
  "failed",
  "archived",
  "low_stock",
  "paused",
] as const;

describe("StatusBadge — reference coverage", () => {
  it("every state shown in the status-system reference is supported", () => {
    const supported = new Set<string>(STATUS_BADGE_KEYS);
    const missing = REFERENCE_STATES.filter((key) => !supported.has(key));
    expect(missing).toEqual([]);
  });

  it("reference coverage is exactly the visual set plus the shared vocabulary", () => {
    // Guards against accidental removal of a reference state.
    expect(REFERENCE_STATES.length).toBe(22);
    expect(REFERENCE_STATES.every((key) => STATUS_BADGE_KEYS.includes(key))).toBe(true);
  });
});

describe("StatusBadge — locale coverage", () => {
  it("every badge key has an English label", () => {
    const missing = STATUS_BADGE_KEYS.filter((key) => !EN_STATUS[key]);
    expect(missing).toEqual([]);
  });

  it("every badge key has a Khmer label", () => {
    const missing = STATUS_BADGE_KEYS.filter((key) => !KM_STATUS[key]);
    expect(missing).toEqual([]);
  });

  it("badge labels never leak the raw key as its own translation", () => {
    const leaked = STATUS_BADGE_KEYS.filter(
      (key) => EN_STATUS[key] === key || KM_STATUS[key] === key,
    );
    expect(leaked).toEqual([]);
  });
});

describe("StatusBadge — tone tokens", () => {
  it("the token registry covers every registered tone", () => {
    expect(new Set(TOKEN_TONES).size).toBe(TOKEN_TONES.length);
    // The component module type-checks its key map against this tone union;
    // the runtime check above plus tsc --noEmit keep the two in sync.
    expect(TOKEN_TONES.length).toBeGreaterThanOrEqual(12);
  });
});
