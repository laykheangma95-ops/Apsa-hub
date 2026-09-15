/**
 * Orders — unknown-source presentation, proven BEHAVIOURALLY.
 *
 * The earlier version of these assertions only regex-matched the route source
 * text, so it passed while the surfaces still rendered "Entered by hand" for
 * an unrecognised DB source. These tests instead push real DB values through
 * the real mapper and render the real design-system components with
 * react-dom/server, asserting on the HTML that actually comes out.
 *
 * Contract under test:
 *   POS / FACEBOOK / INSTAGRAM / TELEGRAM -> that channel's badge
 *   MANUAL                                -> "Entered by hand" caption
 *   WHATSAPP / "" / null / garbage        -> generic "other" badge
 *   no source recorded at all             -> no claim rendered
 *
 * The one thing that must never happen: an unidentified source presented as
 * hand-entered.
 *
 * Run: bun test src/tests/orders-source-presentation.test.ts
 */
import { describe, it, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelBadge } from "@/design-system";
import { mapOrderSummaryToUi, presentOrderSource } from "@/lib/orders";
import i18n from "@/lib/i18n";
import en from "../locales/en.json";
import type { OrderSummary as ServerOrderSummary } from "@/server/orders/service";

// English so the assertions read against known copy; i18n initialises on import.
await i18n.changeLanguage("en");

const MANUAL_CAPTION = en.order.sourceManual;
const CHANNEL_LABELS = en.channel as Record<string, string>;

const BASE_SUMMARY = {
  id: "ord_1",
  orderNumber: "APS-0001",
  customerId: "cus_1",
  subtotal: { amount: 1000, currency: "USD" },
  discount: { amount: 0, currency: "USD" },
  delivery: { amount: 0, currency: "USD" },
  total: { amount: 1000, currency: "USD" },
  paymentStatus: "unpaid",
  fulfillmentStatus: "unfulfilled",
  lifecycleStatus: "draft",
  createdAt: "2026-01-01T00:00:00.000Z",
  locationId: "loc_1",
  source: "POS",
} as unknown as ServerOrderSummary;

/**
 * Renders exactly what both Order surfaces render for a given source: the
 * shared presenter's decision, materialised through the same components the
 * routes use (ChannelBadge, or the manual caption, or nothing).
 */
function renderSourceCell(source: unknown): string {
  const presented = presentOrderSource(source as never);
  if (presented.kind === "channel")
    return renderToStaticMarkup(
      createElement(ChannelBadge, { channel: presented.channel, withLabel: true }),
    );
  if (presented.kind === "manual") return MANUAL_CAPTION;
  return "";
}

/** Pushes a raw DB value through the production mapper, then renders it. */
function renderFromDb(dbSource: unknown): string {
  const order = mapOrderSummaryToUi({ ...BASE_SUMMARY, source: dbSource as never });
  return renderSourceCell(order.source);
}

const KNOWN: ReadonlyArray<[string, string]> = [
  ["POS", "pos"],
  ["FACEBOOK", "facebook"],
  ["INSTAGRAM", "instagram"],
  ["TELEGRAM", "telegram"],
];

const UNKNOWN: readonly unknown[] = [
  "WHATSAPP",
  "",
  null,
  undefined,
  "legacy_garbage_42",
  "pos",
  "Facebook",
  "sms",
  42,
];

describe("Orders source presentation — known DB values", () => {
  for (const [db, channel] of KNOWN) {
    it(`${db} renders the ${channel} badge, not the manual caption`, () => {
      const html = renderFromDb(db);
      expect(html).toContain(CHANNEL_LABELS[channel]);
      expect(html).not.toContain(MANUAL_CAPTION);
      expect(html).toContain("<svg");
    });
  }

  it("MANUAL renders the 'Entered by hand' caption", () => {
    expect(renderFromDb("MANUAL")).toBe(MANUAL_CAPTION);
  });
});

describe("Orders source presentation — unknown/unsupported DB values", () => {
  for (const raw of UNKNOWN) {
    it(`${JSON.stringify(raw)} renders the generic 'other' badge`, () => {
      const html = renderFromDb(raw);
      expect(html).toContain(CHANNEL_LABELS["other"]);
      expect(html).toContain("<svg");
    });

    it(`${JSON.stringify(raw)} NEVER renders "${MANUAL_CAPTION}"`, () => {
      // The regression this whole change exists to kill.
      expect(renderFromDb(raw)).not.toContain(MANUAL_CAPTION);
    });

    it(`${JSON.stringify(raw)} is never presented as a false platform`, () => {
      const html = renderFromDb(raw);
      for (const channel of ["pos", "facebook", "instagram", "telegram"]) {
        expect(html).not.toContain(CHANNEL_LABELS[channel]);
      }
    });
  }
});

describe("Orders source presentation — UI-side values and absence", () => {
  it("an uppercase/legacy value reaching the UI guard degrades to 'other'", () => {
    for (const raw of ["POS", "Telegram", "telegram "]) {
      const html = renderSourceCell(raw);
      expect(html).toContain(CHANNEL_LABELS["other"]);
      expect(html).not.toContain(MANUAL_CAPTION);
    }
  });

  it("an explicitly manual UI source still reads 'Entered by hand'", () => {
    expect(renderSourceCell("manual")).toBe(MANUAL_CAPTION);
  });

  it("a genuinely absent source asserts nothing at all", () => {
    // Absence is not manual and not a channel — the surface stays silent
    // rather than inventing provenance.
    expect(presentOrderSource(undefined)).toEqual({ kind: "absent" });
    expect(presentOrderSource(null)).toEqual({ kind: "absent" });
    expect(renderSourceCell(undefined)).toBe("");
  });

  it("every presenter channel outcome is renderable (no crash, no blank icon)", () => {
    for (const raw of [...KNOWN.map(([db]) => db), ...UNKNOWN]) {
      const order = mapOrderSummaryToUi({ ...BASE_SUMMARY, source: raw as never });
      const presented = presentOrderSource(order.source);
      expect(presented.kind).toBe("channel");
      if (presented.kind === "channel") {
        expect(() =>
          renderToStaticMarkup(
            createElement(ChannelBadge, { channel: presented.channel, withLabel: true }),
          ),
        ).not.toThrow();
      }
    }
  });
});
