/**
 * Scan identity router — comprehensive tests.
 *
 * Three layers:
 *   1. Normalization (pure): whitespace, control chars, UPC/EAN, scanner suffixes
 *   2. Classification (pure): identity type detection via classifyScan
 *   3. Resolution (simulated): tenant-scoped lookup, permission gating, UPC/EAN
 *      fallback, graceful unknown handling
 *
 * The resolution layer simulates the server service's behaviour with in-memory
 * stores rather than hitting a real database — the same pattern used by
 * parcel-tenant-isolation.test.ts.
 *
 * Run: bun test src/tests/scan-identity-router.test.ts
 */
import { describe, it, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { normalizeScanInput, upcAToEan13, ean13ToUpcA } from "../lib/barcode/normalize";
import { classifyScan, type ScanIdentity } from "../lib/barcode/scan-router";
import {
  PARCEL_CODE_PREFIX,
  PARCEL_CODE_LENGTH,
  isValidParcelCode,
} from "../lib/barcode/parcel-code";
import {
  formatApsaBarcode,
  isValidApsaBarcode,
  APSA_BARCODE_LENGTH,
} from "../lib/barcode/apsa-code";
import type { ScanResolution } from "../server/scan/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

const VARIANT_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORDER_UUID = "12345678-90ab-4cde-8f01-234567890abc";
const ORG_A = "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeParcelCode(): string {
  return `${PARCEL_CODE_PREFIX}${randomBytes(16).toString("base64url")}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("normalizeScanInput", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeScanInput("  4006381333931  ")).toBe("4006381333931");
  });

  it("strips ASCII control characters (FNC1 / GS)", () => {
    expect(normalizeScanInput("4006381\x1D333931")).toBe("4006381333931");
  });

  it("strips carriage return and line feed", () => {
    expect(normalizeScanInput("4006381333931\r\n")).toBe("4006381333931");
  });

  it("strips null bytes", () => {
    expect(normalizeScanInput("\x004006381333931\x00")).toBe("4006381333931");
  });

  it("strips mixed control characters and whitespace", () => {
    expect(normalizeScanInput(" \t\x1D 4006381333931 \r\n ")).toBe("4006381333931");
  });

  it("returns null for empty string", () => {
    expect(normalizeScanInput("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(normalizeScanInput("   \t  \n  ")).toBeNull();
  });

  it("returns null for control-chars-only", () => {
    expect(normalizeScanInput("\x1D\x00\x0A")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(normalizeScanInput(null as unknown)).toBeNull();
    expect(normalizeScanInput(undefined as unknown)).toBeNull();
    expect(normalizeScanInput(42 as unknown)).toBeNull();
  });

  it("returns null for excessively long input", () => {
    expect(normalizeScanInput("A".repeat(101))).toBeNull();
  });

  it("preserves exactly 100-char input", () => {
    const code = "A".repeat(100);
    expect(normalizeScanInput(code)).toBe(code);
  });

  it("preserves APSA parcel codes as-is (case-sensitive)", () => {
    const code = makeParcelCode();
    expect(normalizeScanInput(code)).toBe(code);
  });

  it("preserves APSA QR payloads as-is", () => {
    const payload = `apsa:variant/${VARIANT_UUID}`;
    expect(normalizeScanInput(payload)).toBe(payload);
  });
});

describe("UPC-A / EAN-13 normalization", () => {
  it("converts 12-digit UPC-A to 13-digit EAN-13", () => {
    expect(upcAToEan13("012345678905")).toBe("0012345678905");
  });

  it("returns null for non-12-digit string", () => {
    expect(upcAToEan13("4006381333931")).toBeNull(); // 13 digits
    expect(upcAToEan13("12345")).toBeNull(); // 5 digits
  });

  it("returns null for 12-char non-numeric string", () => {
    expect(upcAToEan13("ABCDEFGHIJKL")).toBeNull();
  });

  it("converts 13-digit EAN-13 starting with 0 to 12-digit UPC-A", () => {
    expect(ean13ToUpcA("0012345678905")).toBe("012345678905");
  });

  it("returns null for EAN-13 NOT starting with 0", () => {
    expect(ean13ToUpcA("4006381333931")).toBeNull();
  });

  it("returns null for non-13-digit string", () => {
    expect(ean13ToUpcA("012345678905")).toBeNull(); // 12 digits
  });

  it("round-trips UPC-A → EAN-13 → UPC-A", () => {
    const upc = "012345678905";
    const ean = upcAToEan13(upc);
    expect(ean).not.toBeNull();
    expect(ean13ToUpcA(ean!)).toBe(upc);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CLASSIFICATION (via classifyScan, extended coverage)
// ═══════════════════════════════════════════════════════════════════════════════

describe("classifyScan: product barcodes", () => {
  it("classifies EAN-13 as product-barcode", () => {
    const result = classifyScan("4006381333931");
    expect(result.kind).toBe("product-barcode");
    expect((result as { code: string }).code).toBe("4006381333931");
  });

  it("classifies UPC-A as product-barcode", () => {
    expect(classifyScan("012345678905").kind).toBe("product-barcode");
  });

  it("classifies EAN-8 as product-barcode", () => {
    expect(classifyScan("96385074").kind).toBe("product-barcode");
  });

  it("classifies APSA-generated barcode as product-barcode", () => {
    const barcode = formatApsaBarcode(ORG_A, "00831527");
    expect(isValidApsaBarcode(barcode)).toBe(true);
    expect(classifyScan(barcode).kind).toBe("product-barcode");
  });

  it("classifies random manufacturer code as product-barcode", () => {
    expect(classifyScan("ABC-12345").kind).toBe("product-barcode");
  });

  it("classifies alphanumeric retail code as product-barcode", () => {
    expect(classifyScan("SKU-2024-XL-BLK").kind).toBe("product-barcode");
  });
});

describe("classifyScan: APSA parcel codes", () => {
  it("classifies valid parcel QR as apsa-parcel", () => {
    const code = makeParcelCode();
    expect(code.length).toBe(PARCEL_CODE_LENGTH);
    const result = classifyScan(code);
    expect(result.kind).toBe("apsa-parcel");
    expect((result as { code: string }).code).toBe(code);
  });

  it("rejects too-short parcel prefix as unknown", () => {
    expect(classifyScan("APSA:PCL:v1:tooshort").kind).toBe("unknown");
  });

  it("rejects parcel code with invalid characters as unknown", () => {
    expect(classifyScan("APSA:PCL:v1:kB7xR2mN9pQ4wF5yL3h!X").kind).toBe("unknown");
  });

  it("never confuses a parcel code with a product barcode", () => {
    const code = makeParcelCode();
    expect(classifyScan(code).kind).not.toBe("product-barcode");
  });

  it("parcel prefix takes priority over APSA product prefix", () => {
    const code = makeParcelCode();
    expect(code.startsWith("APSA")).toBe(true);
    expect(classifyScan(code).kind).toBe("apsa-parcel");
  });
});

describe("classifyScan: APSA parcel Code128", () => {
  it("classifies a Code128-encoded parcel code the same as a QR scan", () => {
    const code = makeParcelCode();
    const result = classifyScan(code);
    expect(result.kind).toBe("apsa-parcel");
  });
});

describe("classifyScan: APSA variant QR", () => {
  it("classifies apsa:variant/<uuid> as apsa-variant", () => {
    const result = classifyScan(`apsa:variant/${VARIANT_UUID}`);
    expect(result.kind).toBe("apsa-variant");
    expect((result as { id: string }).id).toBe(VARIANT_UUID);
  });

  it("rejects apsa:variant/ with non-UUID as product-barcode (falls through)", () => {
    expect(classifyScan("apsa:variant/not-a-uuid").kind).toBe("product-barcode");
  });
});

describe("classifyScan: APSA order QR", () => {
  it("classifies apsa:order/<uuid> as apsa-order", () => {
    const result = classifyScan(`apsa:order/${ORDER_UUID}`);
    expect(result.kind).toBe("apsa-order");
    expect((result as { id: string }).id).toBe(ORDER_UUID.toLowerCase());
  });

  it("rejects apsa:order/ with non-UUID", () => {
    expect(classifyScan("apsa:order/not-a-uuid").kind).toBe("product-barcode");
  });
});

describe("classifyScan: malformed and unknown payloads", () => {
  it("classifies empty string as unknown", () => {
    expect(classifyScan("").kind).toBe("unknown");
  });

  it("classifies null/undefined as unknown", () => {
    expect(classifyScan(null as unknown as string).kind).toBe("unknown");
    expect(classifyScan(undefined as unknown as string).kind).toBe("unknown");
  });

  it("invalid APSA product barcode (wrong Luhn) is unknown", () => {
    expect(classifyScan("APSA1ICJ008315279").kind).toBe("unknown");
  });

  it("rejects apsa: with unknown kind", () => {
    const result = classifyScan(`apsa:widget/${VARIANT_UUID}`);
    expect(result.kind).toBe("product-barcode");
  });

  it("rejects apsa: with missing slash", () => {
    expect(classifyScan("apsa:variant").kind).toBe("product-barcode");
  });

  it("rejects APSA:PCL:v2: (wrong version)", () => {
    const code = "APSA:PCL:v2:" + randomBytes(16).toString("base64url");
    // Doesn't match the v1 parcel prefix → falls through
    const result = classifyScan(code);
    expect(result.kind).not.toBe("apsa-parcel");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. RESOLUTION (simulated server-side behaviour)
// ═══════════════════════════════════════════════════════════════════════════════

// Simulated in-memory stores for org-scoped resolution.
// The real server does DB lookups; this simulation proves the routing and
// tenant-isolation logic without a database.

interface SimProduct {
  variantId: string;
  productId: string;
  variantName: string;
  barcode: string;
  orgId: string;
}

interface SimParcel {
  parcelId: string;
  parcelCode: string;
  orderId: string;
  orderNumber: string;
  status: string;
  orgId: string;
}

interface SimVariant {
  variantId: string;
  productId: string;
  variantName: string;
  orgId: string;
}

interface SimOrder {
  orderId: string;
  orderNumber: string;
  lifecycleStatus: string;
  orgId: string;
}

interface SimCtx {
  orgId: string;
  permissions: Set<string>;
}

const PRODUCT_A: SimProduct = {
  variantId: "v1111111-1111-4111-8111-111111111111",
  productId: "p1111111-1111-4111-8111-111111111111",
  variantName: "Red T-Shirt / L",
  barcode: "4006381333931",
  orgId: ORG_A,
};

const PRODUCT_UPC: SimProduct = {
  variantId: "v2222222-2222-4222-8222-222222222222",
  productId: "p2222222-2222-4222-8222-222222222222",
  variantName: "Blue Cap",
  barcode: "0012345678905", // stored as EAN-13
  orgId: ORG_A,
};

const PARCEL_A: SimParcel = {
  parcelId: "pc111111-1111-4111-8111-111111111111",
  parcelCode: `${PARCEL_CODE_PREFIX}${randomBytes(16).toString("base64url")}`,
  orderId: "o1111111-1111-4111-8111-111111111111",
  orderNumber: "APSA-2026-001048",
  status: "created",
  orgId: ORG_A,
};

const VARIANT_A: SimVariant = {
  variantId: VARIANT_UUID,
  productId: "p3333333-3333-4333-8333-333333333333",
  variantName: "Green Hoodie / M",
  orgId: ORG_A,
};

const ORDER_A: SimOrder = {
  orderId: ORDER_UUID,
  orderNumber: "APSA-2026-002001",
  lifecycleStatus: "confirmed",
  orgId: ORG_A,
};

const products = [PRODUCT_A, PRODUCT_UPC];
const parcels = [PARCEL_A];
const variants = [VARIANT_A];
const orders = [ORDER_A];

function simulateResolveScan(ctx: SimCtx, raw: string): ScanResolution {
  const normalized = normalizeScanInput(raw);
  if (normalized === null) {
    return { type: "unknown", payload: String(raw ?? "").slice(0, 100), metadata: null };
  }

  const identity = classifyScan(normalized);

  switch (identity.kind) {
    case "apsa-parcel": {
      if (!ctx.permissions.has("fulfillment.scan_parcel")) {
        return { type: "unknown", payload: normalized, metadata: null };
      }
      if (!isValidParcelCode(identity.code)) {
        return { type: "unknown", payload: normalized, metadata: null };
      }
      const p = parcels.find((x) => x.parcelCode === identity.code && x.orgId === ctx.orgId);
      if (!p) return { type: "unknown", payload: normalized, metadata: null };
      return {
        type: "parcel",
        payload: normalized,
        metadata: {
          parcelId: p.parcelId,
          orderId: p.orderId,
          orderNumber: p.orderNumber,
          status: p.status,
        },
      };
    }

    case "apsa-variant": {
      if (!ctx.permissions.has("products.read")) {
        return { type: "unknown", payload: normalized, metadata: null };
      }
      const v = variants.find((x) => x.variantId === identity.id && x.orgId === ctx.orgId);
      if (!v) return { type: "unknown", payload: normalized, metadata: null };
      return {
        type: "variant",
        payload: normalized,
        metadata: { variantId: v.variantId, productId: v.productId, variantName: v.variantName },
      };
    }

    case "apsa-order": {
      if (!ctx.permissions.has("orders.read")) {
        return { type: "unknown", payload: normalized, metadata: null };
      }
      const o = orders.find((x) => x.orderId === identity.id && x.orgId === ctx.orgId);
      if (!o) return { type: "unknown", payload: normalized, metadata: null };
      return {
        type: "order",
        payload: normalized,
        metadata: {
          orderId: o.orderId,
          orderNumber: o.orderNumber,
          lifecycleStatus: o.lifecycleStatus,
        },
      };
    }

    case "product-barcode": {
      if (!ctx.permissions.has("products.read")) {
        return { type: "unknown", payload: normalized, metadata: null };
      }
      // Exact match
      const exact = products.find((x) => x.barcode === identity.code && x.orgId === ctx.orgId);
      if (exact) {
        return {
          type: "product",
          payload: normalized,
          metadata: {
            variantId: exact.variantId,
            productId: exact.productId,
            variantName: exact.variantName,
            barcode: exact.barcode,
          },
        };
      }
      // UPC-A → EAN-13 fallback
      const ean = upcAToEan13(identity.code);
      if (ean) {
        const eanMatch = products.find((x) => x.barcode === ean && x.orgId === ctx.orgId);
        if (eanMatch) {
          return {
            type: "product",
            payload: normalized,
            metadata: {
              variantId: eanMatch.variantId,
              productId: eanMatch.productId,
              variantName: eanMatch.variantName,
              barcode: eanMatch.barcode,
            },
          };
        }
      }
      // EAN-13 → UPC-A fallback
      const upc = ean13ToUpcA(identity.code);
      if (upc) {
        const upcMatch = products.find((x) => x.barcode === upc && x.orgId === ctx.orgId);
        if (upcMatch) {
          return {
            type: "product",
            payload: normalized,
            metadata: {
              variantId: upcMatch.variantId,
              productId: upcMatch.productId,
              variantName: upcMatch.variantName,
              barcode: upcMatch.barcode,
            },
          };
        }
      }
      return { type: "unknown", payload: normalized, metadata: null };
    }

    case "unknown":
      return { type: "unknown", payload: normalized, metadata: null };
  }
}

// Full-permission context for Org A
const CTX_A: SimCtx = {
  orgId: ORG_A,
  permissions: new Set(["products.read", "orders.read", "fulfillment.scan_parcel"]),
};

// Full-permission context for Org B (different tenant)
const CTX_B: SimCtx = {
  orgId: ORG_B,
  permissions: new Set(["products.read", "orders.read", "fulfillment.scan_parcel"]),
};

// Limited-permission context (no fulfillment)
const CTX_LIMITED: SimCtx = {
  orgId: ORG_A,
  permissions: new Set(["products.read"]),
};

// No permissions at all
const CTX_NONE: SimCtx = {
  orgId: ORG_A,
  permissions: new Set(),
};

describe("resolution: product barcode lookup", () => {
  it("resolves an EAN-13 product barcode in Org A", () => {
    const result = simulateResolveScan(CTX_A, "4006381333931");
    expect(result.type).toBe("product");
    if (result.type !== "product") throw new Error("wrong type");
    expect(result.metadata.variantId).toBe(PRODUCT_A.variantId);
    expect(result.metadata.productId).toBe(PRODUCT_A.productId);
    expect(result.metadata.barcode).toBe("4006381333931");
  });

  it("returns unknown for a product barcode not in this org", () => {
    const result = simulateResolveScan(CTX_B, "4006381333931");
    expect(result.type).toBe("unknown");
  });

  it("returns unknown for a barcode that exists nowhere", () => {
    const result = simulateResolveScan(CTX_A, "9999999999999");
    expect(result.type).toBe("unknown");
  });
});

describe("resolution: UPC-A / EAN-13 fallback", () => {
  it("resolves a 12-digit UPC-A scan when DB stores 13-digit EAN-13", () => {
    // PRODUCT_UPC stores "0012345678905" (13 digits); scanner returns "012345678905" (12)
    const result = simulateResolveScan(CTX_A, "012345678905");
    expect(result.type).toBe("product");
    if (result.type !== "product") throw new Error("wrong type");
    expect(result.metadata.variantId).toBe(PRODUCT_UPC.variantId);
    expect(result.metadata.barcode).toBe("0012345678905");
  });

  it("also resolves the full 13-digit EAN-13 directly", () => {
    const result = simulateResolveScan(CTX_A, "0012345678905");
    expect(result.type).toBe("product");
    if (result.type !== "product") throw new Error("wrong type");
    expect(result.metadata.variantId).toBe(PRODUCT_UPC.variantId);
  });
});

describe("resolution: parcel QR and Code128", () => {
  it("resolves a parcel code in Org A", () => {
    const result = simulateResolveScan(CTX_A, PARCEL_A.parcelCode);
    expect(result.type).toBe("parcel");
    if (result.type !== "parcel") throw new Error("wrong type");
    expect(result.metadata.parcelId).toBe(PARCEL_A.parcelId);
    expect(result.metadata.orderId).toBe(PARCEL_A.orderId);
    expect(result.metadata.orderNumber).toBe(PARCEL_A.orderNumber);
    expect(result.metadata.status).toBe("created");
  });

  it("returns unknown for Org B scanning Org A's parcel", () => {
    const result = simulateResolveScan(CTX_B, PARCEL_A.parcelCode);
    expect(result.type).toBe("unknown");
  });

  it("returns unknown for malformed parcel code", () => {
    const result = simulateResolveScan(CTX_A, "APSA:PCL:v1:tooshort");
    expect(result.type).toBe("unknown");
  });
});

describe("resolution: variant QR", () => {
  it("resolves a variant QR in Org A", () => {
    const result = simulateResolveScan(CTX_A, `apsa:variant/${VARIANT_UUID}`);
    expect(result.type).toBe("variant");
    if (result.type !== "variant") throw new Error("wrong type");
    expect(result.metadata.variantId).toBe(VARIANT_UUID);
    expect(result.metadata.productId).toBe(VARIANT_A.productId);
    expect(result.metadata.variantName).toBe("Green Hoodie / M");
  });

  it("returns unknown for Org B scanning Org A's variant QR", () => {
    const result = simulateResolveScan(CTX_B, `apsa:variant/${VARIANT_UUID}`);
    expect(result.type).toBe("unknown");
  });

  it("returns unknown for a variant UUID not in any org", () => {
    const result = simulateResolveScan(CTX_A, "apsa:variant/99999999-9999-4999-8999-999999999999");
    expect(result.type).toBe("unknown");
  });
});

describe("resolution: order QR", () => {
  it("resolves an order QR in Org A", () => {
    const result = simulateResolveScan(CTX_A, `apsa:order/${ORDER_UUID}`);
    expect(result.type).toBe("order");
    if (result.type !== "order") throw new Error("wrong type");
    expect(result.metadata.orderId).toBe(ORDER_UUID.toLowerCase());
    expect(result.metadata.orderNumber).toBe("APSA-2026-002001");
    expect(result.metadata.lifecycleStatus).toBe("confirmed");
  });

  it("returns unknown for Org B scanning Org A's order QR", () => {
    const result = simulateResolveScan(CTX_B, `apsa:order/${ORDER_UUID}`);
    expect(result.type).toBe("unknown");
  });
});

describe("resolution: unknown / invalid payloads", () => {
  it("empty string → unknown", () => {
    const result = simulateResolveScan(CTX_A, "");
    expect(result.type).toBe("unknown");
  });

  it("whitespace-only → unknown", () => {
    const result = simulateResolveScan(CTX_A, "   \n\r  ");
    expect(result.type).toBe("unknown");
  });

  it("random gibberish → unknown", () => {
    const result = simulateResolveScan(CTX_A, "ᚊᚋᚌᚍ");
    expect(result.type).toBe("unknown");
  });

  it("overlong input → unknown", () => {
    const result = simulateResolveScan(CTX_A, "X".repeat(201));
    expect(result.type).toBe("unknown");
  });

  it("APSA barcode with wrong Luhn → unknown", () => {
    const result = simulateResolveScan(CTX_A, "APSA1ICJ008315279");
    expect(result.type).toBe("unknown");
  });
});

describe("resolution: whitespace normalization", () => {
  it("trims and resolves a product barcode with trailing newline", () => {
    const result = simulateResolveScan(CTX_A, "4006381333931\r\n");
    expect(result.type).toBe("product");
  });

  it("trims and resolves a parcel code with leading space", () => {
    const result = simulateResolveScan(CTX_A, `  ${PARCEL_A.parcelCode}  `);
    expect(result.type).toBe("parcel");
  });

  it("strips GS1 FNC1 and resolves product barcode", () => {
    const result = simulateResolveScan(CTX_A, "4006381\x1D333931");
    expect(result.type).toBe("product");
  });
});

describe("resolution: tenant isolation", () => {
  it("Org A's product is invisible to Org B", () => {
    expect(simulateResolveScan(CTX_B, "4006381333931").type).toBe("unknown");
  });

  it("Org A's parcel is invisible to Org B", () => {
    expect(simulateResolveScan(CTX_B, PARCEL_A.parcelCode).type).toBe("unknown");
  });

  it("Org A's variant QR is invisible to Org B", () => {
    expect(simulateResolveScan(CTX_B, `apsa:variant/${VARIANT_UUID}`).type).toBe("unknown");
  });

  it("Org A's order QR is invisible to Org B", () => {
    expect(simulateResolveScan(CTX_B, `apsa:order/${ORDER_UUID}`).type).toBe("unknown");
  });

  it("not-found and wrong-org are indistinguishable (opaque unknown)", () => {
    const wrongOrg = simulateResolveScan(CTX_B, "4006381333931");
    const notFound = simulateResolveScan(CTX_A, "9999999999999");
    expect(wrongOrg.type).toBe("unknown");
    expect(notFound.type).toBe("unknown");
    // Both return the same shape — cannot distinguish
    expect(wrongOrg.metadata).toBeNull();
    expect(notFound.metadata).toBeNull();
  });
});

describe("resolution: permission enforcement", () => {
  it("returns unknown when user lacks fulfillment.scan_parcel for a parcel scan", () => {
    const result = simulateResolveScan(CTX_LIMITED, PARCEL_A.parcelCode);
    expect(result.type).toBe("unknown");
  });

  it("returns unknown when user lacks products.read for a product scan", () => {
    const result = simulateResolveScan(CTX_NONE, "4006381333931");
    expect(result.type).toBe("unknown");
  });

  it("returns unknown when user lacks orders.read for an order scan", () => {
    const result = simulateResolveScan(CTX_NONE, `apsa:order/${ORDER_UUID}`);
    expect(result.type).toBe("unknown");
  });

  it("returns unknown when user lacks products.read for a variant scan", () => {
    const result = simulateResolveScan(CTX_NONE, `apsa:variant/${VARIANT_UUID}`);
    expect(result.type).toBe("unknown");
  });
});

describe("resolution: duplicate prevention (exact match only)", () => {
  it("exact match returns the stored barcode, not a guess", () => {
    const result = simulateResolveScan(CTX_A, "4006381333931");
    expect(result.type).toBe("product");
    if (result.type !== "product") throw new Error("wrong type");
    expect(result.metadata.barcode).toBe("4006381333931");
  });

  it("a near-miss barcode (off by one digit) does not resolve", () => {
    const result = simulateResolveScan(CTX_A, "4006381333932");
    expect(result.type).toBe("unknown");
  });
});

describe("resolution: invalid format rejection", () => {
  it("rejects APSA:PCL:v1: with invalid base64url characters", () => {
    const result = simulateResolveScan(CTX_A, "APSA:PCL:v1:kB7xR2mN9pQ4wF5yL3h!");
    expect(result.type).toBe("unknown");
  });

  it("rejects apsa:variant with non-UUID id", () => {
    const result = simulateResolveScan(CTX_A, "apsa:variant/not-a-uuid");
    // Falls through to product-barcode, then not found → unknown
    expect(result.type).toBe("unknown");
  });

  it("rejects apsa:order with non-UUID id", () => {
    const result = simulateResolveScan(CTX_A, "apsa:order/not-a-uuid");
    expect(result.type).toBe("unknown");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. INTEGRATION: normalize + classify + resolve (end-to-end)
// ═══════════════════════════════════════════════════════════════════════════════

describe("end-to-end: camera scan with control characters resolves correctly", () => {
  it("camera returns parcel code with trailing \\r\\n → resolves as parcel", () => {
    const raw = `${PARCEL_A.parcelCode}\r\n`;
    const result = simulateResolveScan(CTX_A, raw);
    expect(result.type).toBe("parcel");
  });

  it("camera returns EAN-13 with GS1 separator → resolves as product", () => {
    const raw = `\x1D4006381333931`;
    const result = simulateResolveScan(CTX_A, raw);
    expect(result.type).toBe("product");
  });

  it("camera returns variant QR with leading whitespace → resolves as variant", () => {
    const raw = `  apsa:variant/${VARIANT_UUID}  `;
    const result = simulateResolveScan(CTX_A, raw);
    expect(result.type).toBe("variant");
  });

  it("camera returns order QR with null bytes → resolves as order", () => {
    const raw = `\x00apsa:order/${ORDER_UUID}\x00`;
    const result = simulateResolveScan(CTX_A, raw);
    expect(result.type).toBe("order");
  });
});

describe("every scan returns exactly one identity type", () => {
  const samples = [
    "4006381333931",
    PARCEL_A.parcelCode,
    `apsa:variant/${VARIANT_UUID}`,
    `apsa:order/${ORDER_UUID}`,
    "UNKNOWN-CODE-123",
    "",
    "   ",
    "APSA:PCL:v1:tooshort",
  ];

  for (const sample of samples) {
    it(`scan "${sample.slice(0, 30)}..." returns exactly one type`, () => {
      const result = simulateResolveScan(CTX_A, sample);
      const validTypes: string[] = ["product", "parcel", "variant", "order", "unknown"];
      expect(validTypes).toContain(result.type);
      expect(typeof result.payload).toBe("string");
    });
  }
});
