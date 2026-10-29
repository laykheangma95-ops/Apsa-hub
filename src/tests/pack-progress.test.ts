/**
 * Pack progress storage (src/lib/pack-progress.ts): what survives leaving the
 * Pack Order screen, for whom, and what a restore is allowed to bring back.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPackSession, type PackRequirement, type PackSession } from "@/lib/pack";
import {
  clearPackProgress,
  PACK_PROGRESS_MAX_RECORDS,
  PACK_PROGRESS_TTL_MS,
  readPackProgress,
  restorePackSession,
  savePackProgress,
  type PackProgressRecord,
} from "@/lib/pack-progress";

const SCOPE = { userId: "user-A", organizationId: "org-A", orderId: "order-1" };
const T0 = 1_800_000_000_000;

function requirement(orderItemId: string, variantId: string, quantityRequired: number) {
  return {
    orderItemId,
    productId: `prod-${orderItemId}`,
    variantId,
    productName: `Product ${orderItemId}`,
    variantName: null,
    sku: null,
    barcode: null,
    quantityRequired,
    siblingBarcodes: [],
  } satisfies PackRequirement;
}

const REQUIREMENTS = [requirement("line-1", "variant-1", 2), requirement("line-2", "variant-2", 1)];

function fresh(parcelCode = "PCL-1", requirements: PackRequirement[] = REQUIREMENTS) {
  return createPackSession("order-1", "ORD-1", parcelCode, requirements);
}

function withUnits(
  session: PackSession,
  units: { orderItemId: string; variantId: string }[],
  parcelVerified = false,
): PackSession {
  return {
    ...session,
    parcelVerified,
    packed: units.map((unit, i) => ({ ...unit, method: "scan" as const, scannedAt: T0 + i })),
  };
}

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => [...items.keys()][index] ?? null,
    removeItem: (key: string) => void items.delete(key),
    setItem: (key: string, value: string) => void items.set(key, String(value)),
  };
}

const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

beforeEach(() => {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "sessionStorage", original);
  else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
});

describe("save / read / clear", () => {
  it("round-trips confirmed units and the parcel check, without product details", () => {
    const session = withUnits(fresh(), [{ orderItemId: "line-1", variantId: "variant-1" }], true);
    savePackProgress(SCOPE, session, T0);
    const record = readPackProgress(SCOPE, T0 + 1);
    expect(record).toEqual({
      parcelCode: "PCL-1",
      parcelVerified: true,
      packed: [{ orderItemId: "line-1", variantId: "variant-1", method: "scan", scannedAt: T0 }],
      updatedAt: T0,
    });
    const raw = globalThis.sessionStorage.getItem("apsa.pack-progress.v1") ?? "";
    expect(raw).not.toContain("Product line-1");
  });

  it("a session with nothing confirmed is forgotten, not stored", () => {
    savePackProgress(
      SCOPE,
      withUnits(fresh(), [{ orderItemId: "line-1", variantId: "variant-1" }]),
      T0,
    );
    savePackProgress(SCOPE, fresh(), T0 + 1);
    expect(readPackProgress(SCOPE, T0 + 2)).toBeNull();
  });

  it("clear removes only this scope", () => {
    const other = { ...SCOPE, orderId: "order-2" };
    const session = withUnits(fresh(), [{ orderItemId: "line-1", variantId: "variant-1" }]);
    savePackProgress(SCOPE, session, T0);
    savePackProgress(other, session, T0);
    clearPackProgress(SCOPE, T0 + 1);
    expect(readPackProgress(SCOPE, T0 + 2)).toBeNull();
    expect(readPackProgress(other, T0 + 2)).not.toBeNull();
  });

  it("is scoped by member, organization and order", () => {
    const session = withUnits(fresh(), [{ orderItemId: "line-1", variantId: "variant-1" }]);
    savePackProgress(SCOPE, session, T0);
    expect(readPackProgress({ ...SCOPE, userId: "user-B" }, T0)).toBeNull();
    expect(readPackProgress({ ...SCOPE, organizationId: "org-B" }, T0)).toBeNull();
    expect(readPackProgress({ ...SCOPE, orderId: "order-2" }, T0)).toBeNull();
    expect(readPackProgress(SCOPE, T0)).not.toBeNull();
  });

  it("expires after the TTL", () => {
    savePackProgress(
      SCOPE,
      withUnits(fresh(), [{ orderItemId: "line-1", variantId: "variant-1" }]),
      T0,
    );
    expect(readPackProgress(SCOPE, T0 + PACK_PROGRESS_TTL_MS - 1)).not.toBeNull();
    expect(readPackProgress(SCOPE, T0 + PACK_PROGRESS_TTL_MS)).toBeNull();
  });

  it("keeps at most the newest records", () => {
    const session = withUnits(fresh(), [{ orderItemId: "line-1", variantId: "variant-1" }]);
    for (let i = 0; i <= PACK_PROGRESS_MAX_RECORDS; i++) {
      savePackProgress({ ...SCOPE, orderId: `order-${i}` }, session, T0 + i);
    }
    expect(readPackProgress({ ...SCOPE, orderId: "order-0" }, T0 + 100)).toBeNull();
    expect(
      readPackProgress({ ...SCOPE, orderId: `order-${PACK_PROGRESS_MAX_RECORDS}` }, T0 + 100),
    ).not.toBeNull();
  });

  it("unreadable stored data means nothing is remembered", () => {
    globalThis.sessionStorage.setItem("apsa.pack-progress.v1", "{not json");
    expect(readPackProgress(SCOPE, T0)).toBeNull();
  });

  it("a refused write remembers nothing and does not throw", () => {
    const storage = globalThis.sessionStorage;
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const session = withUnits(fresh(), [{ orderItemId: "line-1", variantId: "variant-1" }]);
    expect(() => savePackProgress(SCOPE, session, T0)).not.toThrow();
    expect(readPackProgress(SCOPE, T0)).toBeNull();
  });

  it("without sessionStorage, a page-lifetime copy stands in", () => {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
    const session = withUnits(fresh(), [{ orderItemId: "line-1", variantId: "variant-1" }]);
    savePackProgress(SCOPE, session, T0);
    expect(readPackProgress(SCOPE, T0)?.packed).toHaveLength(1);
    clearPackProgress(SCOPE, T0);
    expect(readPackProgress(SCOPE, T0)).toBeNull();
  });
});

describe("restorePackSession", () => {
  function saved(
    packed: { orderItemId: string; variantId: string; method?: string }[],
    extra: Partial<PackProgressRecord> = {},
  ): PackProgressRecord {
    return {
      parcelCode: "PCL-1",
      parcelVerified: false,
      packed: packed.map((unit, i) => ({
        orderItemId: unit.orderItemId,
        variantId: unit.variantId,
        method: (unit.method ?? "manual") as "manual",
        scannedAt: T0 + i,
      })),
      updatedAt: T0,
      ...extra,
    };
  }

  it("nothing saved: the fresh session unchanged", () => {
    const session = fresh();
    expect(restorePackSession(session, null)).toBe(session);
  });

  it("restores units for current lines and keeps requirements from the server", () => {
    const restored = restorePackSession(
      fresh(),
      saved([
        { orderItemId: "line-1", variantId: "variant-1" },
        { orderItemId: "line-2", variantId: "variant-2", method: "scan" },
      ]),
    );
    expect(restored.requirements).toBe(REQUIREMENTS);
    expect(restored.packed.map((p) => [p.orderItemId, p.method])).toEqual([
      ["line-1", "manual"],
      ["line-2", "scan"],
    ]);
  });

  it("drops units for lines the order no longer has, or with another variant", () => {
    const restored = restorePackSession(
      fresh(),
      saved([
        { orderItemId: "line-gone", variantId: "variant-1" },
        { orderItemId: "line-1", variantId: "variant-other" },
        { orderItemId: "line-1", variantId: "variant-1" },
      ]),
    );
    expect(restored.packed.map((p) => p.orderItemId)).toEqual(["line-1"]);
  });

  it("caps each line at what it requires", () => {
    const restored = restorePackSession(
      fresh(),
      saved([
        { orderItemId: "line-2", variantId: "variant-2" },
        { orderItemId: "line-2", variantId: "variant-2" },
        { orderItemId: "line-2", variantId: "variant-2" },
      ]),
    );
    expect(restored.packed).toHaveLength(1);
  });

  it("drops units with an unknown method", () => {
    const restored = restorePackSession(
      fresh(),
      saved([{ orderItemId: "line-1", variantId: "variant-1", method: "forged" }]),
    );
    expect(restored.packed).toHaveLength(0);
  });

  it("keeps the parcel check only for the same parcel", () => {
    expect(restorePackSession(fresh(), saved([], { parcelVerified: true })).parcelVerified).toBe(
      true,
    );
    expect(
      restorePackSession(fresh("PCL-NEW"), saved([], { parcelVerified: true })).parcelVerified,
    ).toBe(false);
  });
});
