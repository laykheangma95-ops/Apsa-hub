/**
 * Production POS -> Order Integration tests.
 *
 * Follows the established convention for this repo (see
 * src/tests/order-ui-integration.test.ts's own comment): pure logic that has
 * no server/React dependency is unit-tested directly (pos-cart.ts variant
 * handling below); everything about which server function a component calls,
 * what a payload does and does not contain, and the mock/production boundary
 * is proven structurally by reading the actual source text, because this repo
 * has no component-rendering harness.
 *
 * Coverage:
 *   CART (pure logic)
 *     1. variantId threads through addToCart/setQuantity/removeLine
 *     2. two variants of the same product stay separate cart lines
 *     3. re-adding the same product+variant merges into one line
 *     4. client cart totals are derived only from CartLine.unitPrice (never a
 *        server total) — the authoritative price still comes from the server
 *        at order-creation time (structural section below)
 *   PRODUCT / VARIANT MAPPING
 *     5. mapServerProductToUi exposes the full ACTIVE variant list once a
 *        product has more than one, instead of silently keeping only the
 *        first (the historical gap this phase closes)
 *   POS -> ORDER (structural)
 *     6. PosCheckoutSheet's production path calls createRealOrder then
 *        confirmRealOrder — the same two functions Conversation -> Order and
 *        Manual Order already use, never a second creation/confirmation model
 *     7. the production payload has no price/subtotal/total/organizationId/
 *        userId/paymentMethod/paid field
 *     8. the mock payment-method / cash-received UI never renders on the
 *        production path, and vice versa the mock path is untouched
 *     9. no Payment-domain function is called from POS in this phase
 *   IDEMPOTENCY / DUPLICATE SUBMISSION
 *    10. a synchronous submittingRef guard exists and is checked before any
 *        await, so a double tap cannot fire two concurrent submissions
 *    11. a confirm failure after a successful create does not re-run
 *        createRealOrder on retry (createdOrderId short-circuits it)
 *   TENANT / SECURITY BOUNDARY
 *    12. the production/mock routing decision uses isProductionId on every
 *        cart line — a single mock line forces the whole cart through the
 *        untouched mock path, so a non-UUID id can never reach createRealOrder
 *    13. customerId is only ever sent when isProductionId(customer.id) is true
 *   MOCK / PRODUCTION CUSTOMER BOUNDARY
 *    14. searchCustomers / createQuickCustomer try the production Customer
 *        domain first and fall back to mock data only in demo-mode contexts
 *        (the same isDemoModeError convention as getPosProducts)
 *   REGRESSION
 *    15. PosProductList / PosCustomerSheet are unmodified by this phase
 *    16. bundle-boundary is already covered generically for src/routes and
 *        src/api by src/tests/bundle-boundary.test.ts
 *
 * Run: bun test src/tests/pos-order-integration.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { addToCart, calculateCartTotals, lineKey, removeLine, setQuantity } from "@/lib/pos-cart";
import type { CartLine } from "@/lib/pos-cart";
import { usd } from "@/lib/money";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

const API_INDEX = "src/lib/api/index.ts";
const CHECKOUT_SHEET = "src/components/pos/PosCheckoutSheet.tsx";
const VARIANT_SHEET = "src/components/pos/PosVariantSheet.tsx";
const POS_ROUTE = "src/routes/app.pos.tsx";
const POS_CART_LIB = "src/lib/pos-cart.ts";
const PRODUCT_LIST = "src/components/pos/PosProductList.tsx";
const CUSTOMER_SHEET = "src/components/pos/PosCustomerSheet.tsx";

// ═══════════════════════════════════════════════════════════════════════════
// 1. CART — pure logic: variantId threading
// ═══════════════════════════════════════════════════════════════════════════

function makeLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    key: lineKey("prod-1", overrides.variantId),
    productId: "prod-1",
    nameKm: "ផលិតផល",
    nameEn: "Product",
    sku: "SKU-1",
    quantity: 1,
    unitPrice: usd(1000),
    stock: 0,
    ...overrides,
  };
}

describe("pos-cart: variantId threads through cart operations", () => {
  it("lineKey differs for two variants of the same product", () => {
    const a = lineKey("prod-1", "variant-a");
    const b = lineKey("prod-1", "variant-b");
    expect(a).not.toEqual(b);
  });

  it("adding two different variants of the same product creates two lines", () => {
    let lines: CartLine[] = [];
    lines = addToCart(
      lines,
      makeLine({ key: lineKey("prod-1", "variant-a"), variantId: "variant-a" }),
    );
    lines = addToCart(
      lines,
      makeLine({ key: lineKey("prod-1", "variant-b"), variantId: "variant-b" }),
    );
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.variantId).sort()).toEqual(["variant-a", "variant-b"]);
  });

  it("re-adding the same product+variant merges quantity into one line, not a duplicate", () => {
    let lines: CartLine[] = [];
    const key = lineKey("prod-1", "variant-a");
    lines = addToCart(lines, makeLine({ key, variantId: "variant-a", quantity: 1 }));
    lines = addToCart(lines, makeLine({ key, variantId: "variant-a", quantity: 2 }));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(3);
    expect(lines[0]!.variantId).toBe("variant-a");
  });

  it("setQuantity and removeLine operate by key and never drop variantId", () => {
    const key = lineKey("prod-1", "variant-a");
    let lines: CartLine[] = [makeLine({ key, variantId: "variant-a", stock: 0 })];
    lines = setQuantity(lines, key, 5);
    expect(lines[0]!.quantity).toBe(5);
    expect(lines[0]!.variantId).toBe("variant-a");
    lines = removeLine(lines, key);
    expect(lines).toHaveLength(0);
  });

  it("cart totals are derived only from CartLine.unitPrice — never an externally supplied total", () => {
    const lines: CartLine[] = [
      makeLine({ key: "a", quantity: 2, unitPrice: usd(500) }),
      makeLine({ key: "b", quantity: 1, unitPrice: usd(1500) }),
    ];
    const totals = calculateCartTotals(lines, { enabled: false, mode: "amount", value: 0 });
    expect(totals.subtotal.amount).toBe(2 * 500 + 1500);
    expect(totals.total.amount).toBe(2 * 500 + 1500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. PRODUCT / VARIANT MAPPING — structural
// ═══════════════════════════════════════════════════════════════════════════

describe("mapServerProductToUi exposes every ACTIVE variant, not just the first", () => {
  it("sets productionVariants when a product has more than one server variant", () => {
    const source = readSource(API_INDEX);
    const fn = source.slice(
      source.indexOf("function mapServerProductToUi"),
      source.indexOf("function mapServerProductToUi") + 1800,
    );
    expect(fn).toMatch(/p\.variants\.length > 1/);
    expect(fn).toMatch(/productionVariants/);
  });

  it("Product's productionVariants field is documented as production-only, more-than-one-variant only", () => {
    const source = readSource("src/types/index.ts");
    expect(source).toMatch(/productionVariants\?:\s*ProductionVariant\[\]/);
    expect(source).toMatch(/interface ProductionVariant/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. POS -> ORDER — structural: reuses the authoritative Order Domain
// ═══════════════════════════════════════════════════════════════════════════

describe("PosCheckoutSheet's production path reuses createRealOrder + confirmRealOrder", () => {
  const source = readSource(CHECKOUT_SHEET);

  it("imports createRealOrder and confirmRealOrder from the shared lib/api boundary — no parallel sales engine", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*confirmRealOrder[^}]*createRealOrder[^}]*\}\s*from\s*["']@\/lib\/api["']/s,
    );
  });

  it("never imports or calls a mock order-creation path in the production branch", () => {
    const completeReal = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    expect(completeReal).toMatch(/createRealOrder/);
    expect(completeReal).toMatch(/confirmRealOrder/);
    expect(completeReal).not.toMatch(/createSale\(/);
  });

  it("the production payload has no price, subtotal, total, organizationId, userId or paymentMethod field", () => {
    const completeReal = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    const createCallBlock = completeReal.slice(
      completeReal.indexOf("createRealOrder({"),
      completeReal.indexOf("});", completeReal.indexOf("createRealOrder({")),
    );
    for (const forbidden of [
      "organizationId",
      "organization_id",
      "userId:",
      "user_id",
      "price:",
      "subtotal:",
      "total:",
      "paymentMethod",
      "paid:",
    ]) {
      expect(createCallBlock).not.toContain(forbidden);
    }
    // source is POS — the order carries its own provenance.
    expect(createCallBlock).toMatch(/source:\s*"POS"/);
  });

  it("never sets a payment status, records cash, or infers a payment method on the real path", () => {
    const completeReal = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    for (const forbidden of [
      "paymentStatus:",
      "payment_status",
      "transitionOrderPaymentFn",
      "transitionPaymentStatus",
      "recordPayment(",
    ]) {
      expect(completeReal).not.toContain(forbidden);
    }
  });

  it("calls no Payment-domain function anywhere in the file (payment work is Codex-owned, read-only for this phase)", () => {
    for (const forbidden of [
      "recordPayment",
      "createRefund",
      "transitionOrderPaymentFn",
      "transitionPaymentStatus",
      "PaymentEvidence",
      "reconcil",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("the real-order review screen never renders the payment-method / cash-received controls", () => {
    const realBranch = source.slice(
      source.indexOf(") : isRealCheckout ? ("),
      source.indexOf(") : (", source.indexOf(") : isRealCheckout ? (")),
    );
    expect(realBranch).not.toMatch(/pos\.paymentMethod/);
    expect(realBranch).not.toMatch(/CurrencyInput/);
    expect(realBranch).not.toMatch(/pos\.markPaid/);
  });

  it("the mock path is untouched — still calls createSale with a client-computed total, gated on the mock branch only", () => {
    const mockComplete = source.slice(
      source.indexOf("async function complete("),
      source.indexOf("async function completeReal"),
    );
    expect(mockComplete).toMatch(/createSale\(/);
    expect(mockComplete).toMatch(/paymentMethod:\s*method/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. IDEMPOTENCY / DUPLICATE SUBMISSION
// ═══════════════════════════════════════════════════════════════════════════

describe("Duplicate-submission protection at the POS boundary", () => {
  const source = readSource(CHECKOUT_SHEET);

  it("uses a ref-based guard checked synchronously before any await, so a double tap cannot start two submissions", () => {
    expect(source).toMatch(/submittingRef\s*=\s*useRef\(false\)/);
    const fn = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    const guardIndex = fn.indexOf("if (submittingRef.current) return;");
    const firstAwaitIndex = fn.indexOf("await ");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(firstAwaitIndex);
    expect(fn).toMatch(/submittingRef\.current\s*=\s*true/);
  });

  it("retries after a confirm failure re-use the already-created order id instead of creating a new order", () => {
    const fn = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    expect(fn).toMatch(/let orderId = createdOrderId/);
    expect(fn).toMatch(/if \(!orderId\) \{/);
    // The confirm call sits outside the "if (!orderId)" creation branch, so a
    // retry that already has an orderId skips straight to confirmRealOrder.
    const createBlockEnd = fn.indexOf("onCompleted();") + "onCompleted();".length;
    const confirmCallIndex = fn.indexOf("confirmRealOrder(orderId)");
    expect(confirmCallIndex).toBeGreaterThan(createBlockEnd);
  });

  it("the cart is cleared (onCompleted) as soon as the order is created, before confirm runs — nothing is left to resubmit", () => {
    const fn = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    const createIndex = fn.indexOf("await createRealOrder");
    const onCompletedIndex = fn.indexOf("onCompleted();");
    const confirmIndex = fn.indexOf("await confirmRealOrder");
    expect(createIndex).toBeGreaterThan(-1);
    expect(onCompletedIndex).toBeGreaterThan(createIndex);
    expect(confirmIndex).toBeGreaterThan(onCompletedIndex);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. TENANT / SECURITY BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════

describe("Mock/production routing never trusts a client id as authorization", () => {
  const source = readSource(CHECKOUT_SHEET);

  it("isRealCheckout requires isProductionId on both productId and variantId for every line", () => {
    const decl = source.slice(
      source.indexOf("const isRealCheckout ="),
      source.indexOf(";", source.indexOf("const isRealCheckout =")) + 1,
    );
    expect(decl).toMatch(/lines\.every/);
    expect(decl).toMatch(/isProductionId\(l\.productId\)/);
    expect(decl).toMatch(/isProductionId\(l\.variantId/);
  });

  it("a single mock line forces the WHOLE cart through the untouched mock path (lines.every, not .some)", () => {
    expect(source).not.toMatch(/isRealCheckout[\s\S]{0,40}lines\.some/);
  });

  it("customerId is only sent when isProductionId(customer.id) is true — a mock walk-in customer degrades to null, never sent as-is", () => {
    const fn = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    expect(fn).toMatch(
      /customerId:\s*customer\s*&&\s*isProductionId\(customer\.id\)\s*\?\s*customer\.id\s*:\s*null/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. MOCK / PRODUCTION CUSTOMER BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════

describe("Customer search/quick-create try the production Customer domain first", () => {
  const source = readSource(API_INDEX);

  it("searchCustomers calls listRealCustomers (listCustomersFn) before ever touching mock data", () => {
    const fn = source.slice(
      source.indexOf("export async function searchCustomers"),
      source.indexOf("export interface QuickCustomerInput"),
    );
    expect(fn).toMatch(/listRealCustomers\(\)/);
    expect(fn).toMatch(/isDemoModeError/);
  });

  it("createQuickCustomer calls createCustomerFn before ever falling back to an in-memory mock customer", () => {
    const fn = source.slice(
      source.indexOf("export async function createQuickCustomer"),
      source.indexOf("export interface CreateSaleInput"),
    );
    expect(fn).toMatch(/await import\(["']@\/api\/customers["']\)/);
    expect(fn).toMatch(/createCustomerFn/);
    expect(fn).toMatch(/isDemoModeError/);
  });

  it("a genuine backend error (not demo-mode) propagates rather than being hidden behind mock data", () => {
    const searchFn = source.slice(
      source.indexOf("export async function searchCustomers"),
      source.indexOf("export interface QuickCustomerInput"),
    );
    expect(searchFn).toMatch(/if \(!isDemoModeError\(err\)\) throw err;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. VARIANT SELECTION — explicit choice, never a guess
// ═══════════════════════════════════════════════════════════════════════════

describe("Variant selection never guesses between multiple production variants", () => {
  it("PosVariantSheet never pre-selects a production variant", () => {
    const source = readSource(VARIANT_SHEET);
    expect(source).toMatch(/setSelectedVariantId\(null\)/);
    expect(source).toMatch(/disabled=\{hasProductionVariants && !selectedVariant\}/);
  });

  it("app.pos.tsx opens the variant sheet for any product with more than one production variant", () => {
    const source = readSource(POS_ROUTE);
    expect(source).toMatch(/product\.productionVariants\?\.length \?\? 0\) > 1/);
  });

  it("a chosen production variant's own price is used for the cart line, never the product's default price", () => {
    const source = readSource(POS_ROUTE);
    const fn = source.slice(
      source.indexOf("function addProduct"),
      source.indexOf("function selectProduct"),
    );
    expect(fn).toMatch(/product\.productionVariants\?\.find/);
    expect(fn).toMatch(/chosenVariant\?\.price\s*\?\?\s*product\.price/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. REGRESSION — untouched files / generic boundaries
// ═══════════════════════════════════════════════════════════════════════════

describe("Regressions: files outside this phase's scope are unmodified in structure", () => {
  it("PosProductList still renders from the shared Product type (no parallel product shape)", () => {
    const source = readSource(PRODUCT_LIST);
    expect(source).toMatch(/from "@\/types"/);
    expect(source).toMatch(/products: Product\[\]/);
  });

  it("PosCustomerSheet still delegates entirely to lib/api (no direct server import — bundle boundary)", () => {
    const source = readSource(CUSTOMER_SHEET);
    expect(source).not.toMatch(/@\/server\//);
    expect(source).not.toMatch(/@\/lib\/supabase\/server/);
    expect(source).toMatch(/from "@\/lib\/api"/);
  });

  it("pos-cart.ts stays pure — no React, no fetching, no server imports", () => {
    const source = readSource(POS_CART_LIB);
    expect(source).not.toMatch(/from ["']react["']/);
    expect(source).not.toMatch(/@\/server\//);
    expect(source).not.toMatch(/await fetch|createServerFn/);
  });
});
