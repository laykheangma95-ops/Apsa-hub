/**
 * CreateRealOrderSheet — wrong-variant regression suite.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * `mapServerProductToUi` (src/lib/api/index.ts) sets `Product.variantId` to
 * the FIRST ACTIVE variant the server returned, and exposes the full ACTIVE
 * list as `productionVariants` only when there is more than one — precisely
 * so that a multi-variant product is never sold on that first-variant guess.
 *
 * CreateRealOrderSheet submitted `product.variantId` unconditionally. For a
 * product with several ACTIVE variants that silently created a REAL order,
 * against real stock, at a real price, for whichever SKU happened to sort
 * first. The same bug class was already fixed in PosVariantSheet and
 * PrepareOrderSheet; this suite exists so it cannot be reintroduced here.
 *
 * WHAT IS TESTED HOW
 * ------------------
 * The variant-resolution RULE is pure and lives in @/lib/order-draft, so it
 * is executed directly (behavioural). The sheet's WIRING to that rule — which
 * value reaches createRealOrder, what disables submit — is asserted against
 * the source text, the established method in this repo for React components
 * (see order-ui-integration.test.ts's own header for the rationale: there is
 * no component-rendering harness here).
 *
 * Run: bun test src/tests/create-real-order-variant.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  defaultProductVariantId,
  needsVariantChoice,
  productVariantPrice,
} from "@/lib/order-draft";
import { usd } from "@/lib/money";
import type { Product } from "@/types";

const ROOT = process.cwd();
const CREATE_SHEET = "src/components/orders/CreateRealOrderSheet.tsx";
const PREPARE_SHEET = "src/components/inbox/PrepareOrderSheet.tsx";
const ORDER_DRAFT = "src/lib/order-draft.ts";

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

/** A production product with several ACTIVE variants at DIFFERENT prices. */
const MULTI: Product = {
  id: "prod-multi",
  nameKm: "អាវយឺត",
  nameEn: "T-shirt",
  sku: "TSHIRT-RED-S",
  price: usd(1000),
  stock: null,
  lowStockThreshold: 0,
  companion: "nilo",
  // first ACTIVE variant — the value the defect used to submit
  variantId: "var-red-s",
  productionVariants: [
    { variantId: "var-red-s", name: "Red / S", sku: "TSHIRT-RED-S", price: usd(1000) },
    { variantId: "var-red-l", name: "Red / L", sku: "TSHIRT-RED-L", price: usd(1250) },
    { variantId: "var-blue-l", name: "Blue / L", sku: "TSHIRT-BLUE-L", price: usd(1400) },
  ],
};

/** A production product with exactly one ACTIVE variant. */
const SINGLE: Product = {
  id: "prod-single",
  nameKm: "កាបូប",
  nameEn: "Bag",
  sku: "BAG-1",
  price: usd(2500),
  stock: null,
  lowStockThreshold: 0,
  companion: "minto",
  variantId: "var-bag",
  // Deliberately unset: mapServerProductToUi only populates this when
  // p.variants.length > 1, so a single-variant product must resolve from
  // `variantId` alone.
};

/** A product with no sellable variant at all (nothing ACTIVE server-side). */
const NONE: Product = {
  id: "prod-none",
  nameKm: "គ្មាន",
  nameEn: "Unsellable",
  sku: "",
  price: usd(0),
  stock: null,
  lowStockThreshold: 0,
  companion: "vela",
};

// ═══════════════════════════════════════════════════════════════════════════
// A. A multi-variant product does NOT default to the first variant
// ═══════════════════════════════════════════════════════════════════════════

describe("A. multi-variant products never default to the first ACTIVE variant", () => {
  it("starts unchosen, and specifically does not start on product.variantId", () => {
    expect(needsVariantChoice(MULTI)).toBe(true);
    expect(defaultProductVariantId(MULTI)).toBeNull();
    // The whole point: the first-ACTIVE-variant guess is never the default.
    expect(defaultProductVariantId(MULTI)).not.toBe(MULTI.variantId);
  });

  it("the sheet seeds its variant state from the shared rule, not from the product", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(/useState<string \| null>\(null\)/);
    expect(sheet).toMatch(/setVariantId\(defaultProductVariantId\(next\)\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Submit stays blocked until a variant is chosen
// ═══════════════════════════════════════════════════════════════════════════

describe("B. submit is impossible without an explicit choice", () => {
  it("readiness requires both a product and a resolved variantId", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(/const readyToSubmit = Boolean\(product\) && Boolean\(variantId\)/);
    expect(sheet).toMatch(/disabled=\{!readyToSubmit \|\| submitting\}/);
  });

  it("submit() itself re-checks, so a programmatic call cannot bypass the disabled button", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(/if \(!product \|\| !variantId\) return;/);
  });

  it("the synchronous double-submit ref guard is still in place, after the variant guard", () => {
    const sheet = readSource(CREATE_SHEET);
    const submitFn = sheet.slice(sheet.indexOf("async function submit()"));
    const variantGuard = submitFn.indexOf("if (!product || !variantId) return;");
    const refGuard = submitFn.indexOf("if (submittingRef.current) return;");
    const refSet = submitFn.indexOf("submittingRef.current = true;");
    const firstAwait = submitFn.indexOf("await createRealOrder");
    expect(variantGuard).toBeGreaterThanOrEqual(0);
    expect(refGuard).toBeGreaterThan(variantGuard);
    expect(refSet).toBeGreaterThan(refGuard);
    // Both guards resolve BEFORE the first await — a second tap in the same
    // event tick is rejected without waiting for a re-render.
    expect(firstAwait).toBeGreaterThan(refSet);
  });

  it("tells the merchant why submit is blocked, in a translated string", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(/t\("orderCreate\.chooseVariantFirst"\)/);
    for (const locale of ["en", "km"]) {
      const json = JSON.parse(readSource(`src/locales/${locale}.json`)) as Record<
        string,
        Record<string, string>
      >;
      expect(typeof json.orderCreate?.chooseVariantFirst).toBe("string");
      expect(json.orderCreate!.chooseVariantFirst!.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. The CHOSEN variantId is what reaches createRealOrder
// ═══════════════════════════════════════════════════════════════════════════

describe("C. the chosen variantId is what is submitted", () => {
  it("createRealOrder receives the chosen variantId, never product.variantId", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(
      /createRealOrder\(\{[\s\S]*?items: \[\{ variantId, quantity, productId: product\.id \}\]/,
    );
  });

  /*
   * THE CANARY. If someone later changes submit back to product.variantId,
   * this fails — for CreateRealOrderSheet and for PrepareOrderSheet alike.
   */
  it("neither order sheet references product.variantId on a submit path", () => {
    for (const file of [CREATE_SHEET, PREPARE_SHEET]) {
      const source = readSource(file);
      expect(source).not.toMatch(/variantId: product\.variantId/);
      expect(source).not.toMatch(/variantId: line\.product\.variantId/);
      expect(source).not.toMatch(/variantId: product\.variantId!/);
    }
  });

  it("the client still supplies no price, subtotal, total or organization_id", () => {
    const sheet = readSource(CREATE_SHEET);
    const call = sheet.slice(
      sheet.indexOf("await createRealOrder({"),
      sheet.indexOf("setCreated(detail.order)"),
    );
    expect(call).not.toMatch(/\bprice\b/);
    expect(call).not.toMatch(/subtotal|totalMinor|unitPrice/);
    expect(call).not.toMatch(/organization_?[Ii]d/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The chosen variant's own price drives unit price and every total
// ═══════════════════════════════════════════════════════════════════════════

describe("D. pricing follows the chosen variant", () => {
  it("each variant prices from itself, not from the product's first-variant price", () => {
    expect(productVariantPrice(MULTI, "var-red-l")).toEqual(usd(1250));
    expect(productVariantPrice(MULTI, "var-blue-l")).toEqual(usd(1400));
    // Proof the second and third variants are not silently priced as the first.
    expect(productVariantPrice(MULTI, "var-blue-l")).not.toEqual(MULTI.price);
  });

  it("an unchosen multi-variant product shows the product price and cannot be ordered anyway", () => {
    expect(productVariantPrice(MULTI, null)).toEqual(MULTI.price);
    expect(defaultProductVariantId(MULTI)).toBeNull();
  });

  it("integer minor units only — no floating point enters variant pricing", () => {
    for (const v of MULTI.productionVariants!) {
      const priced = productVariantPrice(MULTI, v.variantId);
      expect(Number.isInteger(priced.amount)).toBe(true);
      expect(priced.currency).toBe(v.price.currency);
    }
  });

  it("the sheet derives unitPrice (and therefore subtotal/total) from the chosen variant", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(
      /const unitPrice = product \? productVariantPrice\(product, variantId\) : usd\(0\)/,
    );
    // subtotal -> discount -> total all descend from unitPrice, unchanged.
    expect(sheet).toMatch(/const subtotal = multiplyMoney\(unitPrice, Math\.max\(1, quantity\)\)/);
    expect(sheet).toMatch(/const total = subtractMoney\(subtotal, discount\)/);
  });

  it("the picker shows each variant's own price so the choice is priced, not blind", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(/\{formatMoney\(v\.price\)\}/);
    expect(sheet).toMatch(/\{v\.name\}/);
    expect(sheet).toMatch(/\{v\.sku\}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Single-variant products still work, with no added friction
// ═══════════════════════════════════════════════════════════════════════════

describe("E. single-variant products resolve themselves", () => {
  it("needs no choice and is immediately submittable", () => {
    expect(needsVariantChoice(SINGLE)).toBe(false);
    expect(defaultProductVariantId(SINGLE)).toBe("var-bag");
  });

  it("prices from the product, which already IS that one variant's price", () => {
    expect(productVariantPrice(SINGLE, "var-bag")).toEqual(usd(2500));
  });

  it("the picker is not rendered at all when no choice is required", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(/const mustChooseVariant = needsVariantChoice\(product\)/);
    expect(sheet).toMatch(/\{mustChooseVariant \? \(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Inactive variants cannot be chosen; unsellable products cannot be picked
// ═══════════════════════════════════════════════════════════════════════════

describe("F. only ACTIVE variants are selectable", () => {
  it("a product with zero sellable variants stays unsellable", () => {
    expect(defaultProductVariantId(NONE)).toBeNull();
    expect(needsVariantChoice(NONE)).toBe(false);
  });

  it("the product list disables a product with neither a variantId nor a variant list", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(
      /disabled=\{!item\.variantId && \(item\.productionVariants\?\.length \?\? 0\) === 0\}/,
    );
  });

  it("the picker renders only productionVariants, which the server builds ACTIVE-only", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(/const activeVariants = product\?\.productionVariants \?\? \[\]/);
    expect(sheet).toMatch(/\{activeVariants\.map\(\(v\) => \{/);

    // The ACTIVE-only guarantee is the server's, and it must stay the server's.
    const repo = readSource("src/server/products/repository.ts");
    expect(repo).toMatch(/if \(!includeArchived\) query = query\.eq\("status", "ACTIVE"\)/);

    // ...and mapServerProductToUi must keep exposing the list only when there
    // is genuinely more than one, which is what makes needsVariantChoice sound.
    const api = readSource("src/lib/api/index.ts");
    expect(api).toMatch(
      /if \(p\.variants\.length > 1\) \{[\s\S]*?productionVariants = p\.variants/,
    );
  });

  it("an id that is not in the ACTIVE list never yields that variant's price", () => {
    // An archived SKU's id cannot be resolved, so it cannot be priced or sold.
    expect(productVariantPrice(MULTI, "var-archived")).toEqual(MULTI.price);
    expect(MULTI.productionVariants!.some((v) => v.variantId === "var-archived")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. Changing product resets a stale variant selection
// ═══════════════════════════════════════════════════════════════════════════

describe("G. changing the product resets the variant", () => {
  it("every product change routes through selectProduct, which reseeds the variant", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(
      /function selectProduct\(next: Product \| null\) \{\s*setProduct\(next\);\s*setVariantId\(defaultProductVariantId\(next\)\);/,
    );
    // Both entry points — picking from the list, and "Change" on the line.
    expect(sheet).toMatch(/onClick=\{\(\) => selectProduct\(item\)\}/);
    expect(sheet).toMatch(/onClick=\{\(\) => selectProduct\(null\)\}/);
    // No raw setProduct outside selectProduct/reset, which would skip the reset.
    const strays = sheet.match(/setProduct\(/g) ?? [];
    expect(strays.length).toBe(2); // selectProduct's own call + reset()
  });

  it("the reseed is correct for each destination: unchosen, resolved, or unsellable", () => {
    // multi -> single: stale multi-variant id is replaced by the single one
    expect(defaultProductVariantId(SINGLE)).toBe("var-bag");
    // single -> multi: resolved id is replaced by "not chosen yet"
    expect(defaultProductVariantId(MULTI)).toBeNull();
    // anything -> cleared / unsellable
    expect(defaultProductVariantId(null)).toBeNull();
    expect(defaultProductVariantId(NONE)).toBeNull();
  });

  it("closing the sheet clears the variant along with the product", () => {
    const sheet = readSource(CREATE_SHEET);
    const reset = sheet.slice(
      sheet.indexOf("function reset()"),
      sheet.indexOf("function handleOpenChange"),
    );
    expect(reset).toMatch(/setProduct\(null\);/);
    expect(reset).toMatch(/setVariantId\(null\);/);
    expect(reset).toMatch(/submittingRef\.current = false;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// One rule, not three
// ═══════════════════════════════════════════════════════════════════════════

describe("the variant rule is shared, not reimplemented per sheet", () => {
  it("both order sheets import the rule from @/lib/order-draft", () => {
    for (const file of [CREATE_SHEET, PREPARE_SHEET]) {
      const source = readSource(file);
      expect(source).toMatch(/from "@\/lib\/order-draft"/);
      expect(source).toMatch(/needsVariantChoice/);
      expect(source).toMatch(/defaultProductVariantId/);
      expect(source).toMatch(/productVariantPrice/);
    }
  });

  it("the rule itself stays pure — no React, no server imports", () => {
    const lib = readSource(ORDER_DRAFT);
    expect(lib).not.toMatch(/from "react"/);
    expect(lib).not.toMatch(/@\/server\//);
  });

  it("PrepareOrderSheet's own gating is unchanged by the refactor", () => {
    const sheet = readSource(PREPARE_SHEET);
    expect(sheet).toMatch(/!needsVariantChoice\(line\.product!\) \|\| Boolean\(line\.variantId\)/);
    expect(sheet).toMatch(/variantId: line\.variantId,/);
    expect(sheet).toMatch(/variantId: line\.variantId!,/);
  });
});
