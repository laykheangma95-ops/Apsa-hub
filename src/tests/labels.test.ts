/**
 * Product + parcel label view-model builders — pure unit tests.
 *
 * Behavioural: assert the assembled view models — barcode/QR presence and
 * payload, price formatting, concise item lines with continuation, and PAID vs
 * COD amount derived from authoritative Money with no ×100 regression.
 *
 * Run: bun test src/tests/labels.test.ts
 */
import { describe, it, expect } from "bun:test";
import { buildProductLabel } from "../lib/labels/product-label";
import { buildParcelLabel, type ParcelLabelInput } from "../lib/labels/parcel-label";
import { buildInternalParcelLabel } from "../lib/labels/internal-parcel-label";
import { parseApsaQrPayload } from "../lib/barcode/payload";

const VARIANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORDER_ID = "12345678-90ab-4cde-8f01-234567890abc";

describe("buildProductLabel", () => {
  it("renders a Code 128 barcode + readable number and formats KHR price", () => {
    const vm = buildProductLabel({
      productName: "Classic Tee",
      variantName: "Black / M",
      sku: "TEE-BM",
      barcode: "APSAK7Q400831527",
      price: { amount: 25000, currency: "KHR" },
    });
    expect(vm.barcode).toBe("APSAK7Q400831527");
    expect(vm.barcodeSvg).toContain("<svg");
    expect(vm.priceFormatted).toBe("៛25,000");
    expect(vm.qr).toBeNull();
  });

  it("formats a USD price with two decimals (no ×100 regression)", () => {
    const vm = buildProductLabel({
      productName: "Cap",
      price: { amount: 1234, currency: "USD" },
    });
    expect(vm.priceFormatted).toBe("$12.34");
    expect(vm.barcodeSvg).toBeNull(); // no barcode supplied
  });

  it("adds an APSA variant QR only when requested with a valid variant id", () => {
    const vm = buildProductLabel({
      productName: "Cap",
      price: { amount: 1000, currency: "USD" },
      includeQr: true,
      variantId: VARIANT_ID,
    });
    expect(vm.qr).not.toBeNull();
    expect(parseApsaQrPayload(vm.qr!.payload)).toEqual({ kind: "variant", id: VARIANT_ID });
    expect(vm.qr!.svg).toContain("<svg");
  });

  it("does not crash on a stored barcode Code 128 cannot encode — renders no bars, keeps the number (§14)", () => {
    // A non-ASCII manufacturer barcode that predates save-time validation.
    const vm = buildProductLabel({
      productName: "Imported Item",
      barcode: "88500 123", // contains a non-breaking space (code 160)
      price: { amount: 1000, currency: "USD" },
    });
    // No throw; the unencodable value renders no bars but the number is still shown.
    expect(vm.barcodeSvg).toBeNull();
    expect(vm.barcode).toBe("88500 123");
  });

  it("renders a responsive Code 128 SVG that scales to the label width (§8)", () => {
    const vm = buildProductLabel({
      productName: "Long Code",
      barcode: "APSAK7Q400831527", // 16-char APSA-style code
      price: { amount: 1000, currency: "USD" },
    });
    expect(vm.barcodeSvg).toContain('width="100%"');
    expect(vm.barcodeSvg).toContain("viewBox=");
  });
});

const PARCEL_CODE = "APSA:PCL:v1:AAAAAAAAAAAAAAAAAAAAAA";

function parcelInput(overrides: Partial<ParcelLabelInput> = {}): ParcelLabelInput {
  return {
    merchant: { businessName: "Dara Shop" },
    customer: {
      name: "Sokha",
      phone: "012345678",
      address: "12 St 240, BKK1, Phnom Penh",
      addressConfirmed: false,
    },
    order: {
      id: ORDER_ID,
      orderNumber: "APSA-2026-001048",
      itemCount: 3,
      items: [
        { quantity: 2, productName: "Classic Tee", variantName: "Black / M" },
        { quantity: 1, productName: "Cap", variantName: "White" },
      ],
    },
    reprint: false,
    payment: { state: "cod", collect: { amount: 75000, currency: "KHR" } },
    delivery: null,
    parcelCode: PARCEL_CODE,
    ...overrides,
  };
}

describe("buildParcelLabel", () => {
  it("formats concise item lines with quantity and variant", () => {
    const vm = buildParcelLabel(parcelInput());
    expect(vm.items[0]!.text).toBe("2 × Classic Tee — Black / M");
    expect(vm.items[1]!.text).toBe("1 × Cap — White");
    expect(vm.overflowCount).toBe(0);
  });

  it("truncates a long order and reports the hidden count (§15)", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      quantity: 1,
      productName: `Item ${i}`,
      variantName: null,
    }));
    const vm = buildParcelLabel(
      parcelInput({ order: { ...parcelInput().order, items, itemCount: 12 } }),
      {
        maxItemLines: 8,
      },
    );
    // The millimetre budget (header, receiver, carrier above; payment, QR,
    // Code 128 and footer reserved below) fits 5 one-row lines + the "+7 more"
    // note — measured in Chromium by parcel-label-layout.test.ts.
    expect(vm.items).toHaveLength(5);
    expect(vm.overflowCount).toBe(7);
  });

  it("shows a COD collect amount from authoritative Money (KHR)", () => {
    const vm = buildParcelLabel(parcelInput());
    expect(vm.payment.paid).toBe(false);
    expect(vm.payment.collectFormatted).toBe("៛75,000");
  });

  it("shows a COD collect amount in USD with no ×100 regression", () => {
    const vm = buildParcelLabel(
      parcelInput({ payment: { state: "cod", collect: { amount: 1234, currency: "USD" } } }),
    );
    expect(vm.payment.collectFormatted).toBe("$12.34");
  });

  it("prints PAID with nothing to collect for a paid order", () => {
    const vm = buildParcelLabel(parcelInput({ payment: { state: "paid", collect: null } }));
    expect(vm.payment.paid).toBe(true);
    expect(vm.payment.collectFormatted).toBeNull();
  });

  it("the shipping label prints the APSA Parcel ID as text only — no APSA QR (CORRECTION-003)", () => {
    const vm = buildParcelLabel(parcelInput());
    expect(vm.parcelCode).toBe(PARCEL_CODE);
    expect(vm).not.toHaveProperty("qr");
    expect(vm).not.toHaveProperty("code128");
  });

  it("the internal APSA Parcel label builds its QR from the parcel identity, never the order id", () => {
    const i = parcelInput();
    const vm = buildInternalParcelLabel({
      merchant: { businessName: i.merchant.businessName },
      order: { id: i.order.id, orderNumber: i.order.orderNumber, itemCount: i.order.itemCount },
      parcelCode: i.parcelCode ?? null,
    });
    expect(vm.qr!.payload).toBe(PARCEL_CODE);
    expect(parseApsaQrPayload(vm.qr!.payload)).toBeNull();
    expect(vm.qr!.svg).toContain("<svg");
    // The QR payload carries no money, phone, address or order id.
    expect(vm.qr!.payload).not.toContain("75000");
    expect(vm.qr!.payload).not.toContain("012345678");
    expect(vm.qr!.payload).not.toContain(ORDER_ID);
  });

  it("carries only name/phone/address (plus the addressConfirmed flag) for the customer — no other PII fields", () => {
    const vm = buildParcelLabel(parcelInput());
    // addressConfirmed is a boolean flag, not PII — email/notes/etc. are still absent.
    expect(Object.keys(vm.customer).sort()).toEqual([
      "address",
      "addressConfirmed",
      "name",
      "phone",
    ]);
  });

  it("carries the addressConfirmed flag through unchanged (§13)", () => {
    expect(buildParcelLabel(parcelInput()).customer.addressConfirmed).toBe(false);
    expect(
      buildParcelLabel(
        parcelInput({
          customer: {
            name: "Sokha",
            phone: "012345678",
            address: "12 St 240",
            addressConfirmed: true,
          },
        }),
      ).customer.addressConfirmed,
    ).toBe(true);
  });

  it("carries the reprint flag through (§19)", () => {
    expect(buildParcelLabel(parcelInput()).reprint).toBe(false);
    expect(buildParcelLabel(parcelInput({ reprint: true })).reprint).toBe(true);
  });

  it("passes delivery info through when present", () => {
    const vm = buildParcelLabel(
      parcelInput({
        delivery: { providerName: "VET Express", trackingNumber: "VET-99", status: "ready" },
      }),
    );
    expect(vm.delivery).toEqual({
      carrierName: "VET Express",
      trackingNumber: "VET-99",
      serviceName: null,
    });
  });
});
