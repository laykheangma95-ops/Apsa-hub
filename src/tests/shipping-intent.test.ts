/**
 * Shipping is an EXPLICIT intent on order creation (Inbox, manual, POS-adjacent
 * Create Order): prefilled customer name/phone/address must never turn a pickup
 * order into a shipment, and a shipping order must carry a real destination.
 *
 * Also pins the create-order rollout rule: the repository writes only through
 * create_order_v3 and never falls back to v2, so an ambiguous outcome can't
 * spawn a second order.
 *
 * Run: bun test src/tests/shipping-intent.test.ts
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShippingIntentSection } from "@/components/orders/ShippingIntentSection";
import {
  EMPTY_SHIPPING_DESTINATION,
  orderShippingPayload,
  shippingIntentReady,
} from "@/lib/shipping-destination";
import "@/lib/i18n";

const root = path.resolve(import.meta.dir, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("orderShippingPayload — shipping needs explicit intent", () => {
  it("pickup + a customer whose address is on file stays pickup", () => {
    const prefilled = { name: "Sokha", phone: "012345678", address: "Street 271, Phnom Penh" };
    expect(orderShippingPayload(false, prefilled)).toBeNull();
    expect(shippingIntentReady(false, prefilled)).toBe(true);
  });

  it("Inbox partial fields (name + phone, no address) without intent: pickup, submit allowed", () => {
    const inboxPrefill = { ...EMPTY_SHIPPING_DESTINATION, name: "Sokha", phone: "012345678" };
    expect(orderShippingPayload(false, inboxPrefill)).toBeNull();
    expect(shippingIntentReady(false, inboxPrefill)).toBe(true);
    // The old inference (any touched field ⇒ ship) would have sent this and been
    // rejected by the server for the missing address, blocking a pickup order.
  });

  it("explicit shipping is not ready until it has a recipient AND an address", () => {
    const partial = { ...EMPTY_SHIPPING_DESTINATION, name: "Sokha", phone: "012345678" };
    expect(shippingIntentReady(true, partial)).toBe(false);
    expect(shippingIntentReady(true, { ...partial, address: "   " })).toBe(false);
  });

  it("explicit shipping with a valid destination sends the trimmed snapshot", () => {
    const full = { name: " Sokha ", phone: " 012345678 ", address: " Street 271, Phnom Penh " };
    expect(shippingIntentReady(true, full)).toBe(true);
    expect(orderShippingPayload(true, full)).toEqual({
      name: "Sokha",
      phone: "012345678",
      address: "Street 271, Phnom Penh",
    });
  });
});

describe("ShippingIntentSection", () => {
  const render = (intent: boolean) =>
    renderToStaticMarkup(
      createElement(ShippingIntentSection, {
        idPrefix: "t",
        intent,
        onIntentChange: () => {},
        value: { name: "Sokha", phone: "012345678", address: "" },
        onChange: () => {},
      }),
    );

  it("off: the switch is shown, unchecked, and the destination fields are not", () => {
    const html = render(false);
    expect(html).toContain('id="t-ship-intent"');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain("t-ship-address");
  });

  it("on: the switch is checked and the destination fields appear", () => {
    const html = render(true);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("t-ship-address");
  });
});

describe("Create Order entry points route through the intent helper", () => {
  for (const file of [
    "src/components/orders/CreateRealOrderSheet.tsx",
    "src/components/inbox/PrepareOrderSheet.tsx",
  ]) {
    it(`${path.basename(file)} sends shipping only via orderShippingPayload(shipIntent, …)`, () => {
      const src = read(file);
      expect(src).toContain("orderShippingPayload(shipIntent, shipping)");
      expect(src).toContain("shippingIntentReady(shipIntent, shipping)");
      expect(src).toContain("useState(false)"); // shipIntent starts OFF (pickup)
      expect(src).not.toContain("shippingDestinationPayload(shipping)");
    });
  }
});

describe("create_order rollout: v3 only, never a v2 fallback", () => {
  it("the order repository writes only through create_order_v3", () => {
    const repo = read("src/server/orders/repository.ts");
    expect(repo).toContain('db.rpc("create_order_v3"');
    expect(repo).not.toMatch(/db\.rpc\("create_order_v2"/);
  });

  it("no server or API layer retries or falls back on a failed create", () => {
    for (const file of ["src/server/orders/service.ts", "src/server/orders/repository.ts"]) {
      const src = read(file);
      expect(src).not.toMatch(/create_order_v2["']\s*[,)]/);
      expect(src).not.toMatch(/fallback/i);
    }
  });
});
