/**
 * Merchant sale journey — continuity tests.
 *
 * Covers the launch-critical path POS/Order creation -> Order -> Payment ->
 * Delivery, asserting the properties that make it one continuous, honest
 * experience rather than a set of screens that disagree with each other.
 *
 * Convention follows src/tests/pos-order-integration.test.ts: pure logic is
 * unit-tested directly (classifyCheckout / isSellable), and everything about
 * which function a component calls, what it renders and when, is proven
 * structurally by reading the actual source text — this repo has no
 * component-rendering harness.
 *
 * The centrepiece is NO FAKE SUCCESS. Before this phase, a real product whose
 * catalog row carried no ACTIVE variant had no variantId; the checkout's
 * two-way test asked "is every line production?" and, on false, ran the
 * PROTOTYPE checkout. One such line therefore sent an entire cart of real
 * goods into createSale(), which fabricates an order code in the browser and
 * maps every non-COD method straight to `paid`. The merchant saw a completed,
 * paid sale. No server had ever heard of it. Every assertion below that names
 * "fabricat", "unsellable" or "prototype" is guarding that hole.
 *
 * Run: bun test src/tests/merchant-sale-journey.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { classifyCheckout, isSellable, type CartLine } from "@/lib/pos-cart";
import { usd } from "@/lib/money";
import type { Product } from "@/types";

const ROOT = process.cwd();
const readSource = (p: string) => fs.readFileSync(path.resolve(ROOT, p), "utf-8");

const CHECKOUT_SHEET = "src/components/pos/PosCheckoutSheet.tsx";
const POS_ROUTE = "src/routes/app.pos.tsx";
const PRODUCT_LIST = "src/components/pos/PosProductList.tsx";
const ORDER_DETAIL = "src/routes/app.orders.$id.tsx";
const ORDER_LIST = "src/routes/app.orders.tsx";
const CREATE_ORDER_SHEET = "src/components/orders/CreateRealOrderSheet.tsx";
const API_INDEX = "src/lib/api/index.ts";

const UUID_A = "3f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const UUID_C = "11111111-2222-3333-4444-555555555555";

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    key: "k",
    productId: UUID_A,
    variantId: UUID_B,
    nameKm: "ទំនិញ",
    nameEn: "Item",
    sku: "SKU-1",
    quantity: 1,
    unitPrice: usd(500),
    stock: 10,
    ...overrides,
  };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: UUID_A,
    nameKm: "ទំនិញ",
    nameEn: "Item",
    sku: "SKU-1",
    price: usd(500),
    stock: null,
    lowStockThreshold: 0,
    companion: "nilo",
    ...overrides,
  } as Product;
}

// ═══════════════════════════════════════════════════════════════════════════
// A. CHECKOUT CLASSIFICATION — no fake success
// ═══════════════════════════════════════════════════════════════════════════

describe("classifyCheckout routes a cart to the only checkout it can honestly use", () => {
  it("a cart of real products with real variants is a production sale", () => {
    expect(classifyCheckout([line(), line({ key: "k2", variantId: UUID_C })])).toBe("production");
  });

  it("a cart of prototype products is a prototype sale", () => {
    expect(classifyCheckout([line({ productId: "prd-1", variantId: undefined })])).toBe(
      "prototype",
    );
  });

  it("ADVERSARIAL: a REAL product with no sellable variant is unsellable — never quietly a prototype sale", () => {
    expect(classifyCheckout([line({ variantId: undefined })])).toBe("unsellable");
    expect(classifyCheckout([line({ variantId: "" })])).toBe("unsellable");
  });

  it("ADVERSARIAL: one variantless real line does NOT drag a cart of real goods into the fabricating path", () => {
    const cart = [
      line(),
      line({ key: "k2", variantId: UUID_C }),
      line({ key: "k3", variantId: undefined }),
    ];
    expect(classifyCheckout(cart)).toBe("unsellable");
    expect(classifyCheckout(cart)).not.toBe("prototype");
  });

  it("ADVERSARIAL: a cart mixing real and prototype lines is unsellable, not prototype", () => {
    expect(
      classifyCheckout([line(), line({ key: "k2", productId: "prd-1", variantId: undefined })]),
    ).toBe("unsellable");
  });

  it("an empty cart is never a sale", () => {
    expect(classifyCheckout([])).toBe("unsellable");
  });

  it("a non-UUID variantId on a real product never passes as production", () => {
    expect(classifyCheckout([line({ variantId: "var-1" })])).toBe("unsellable");
  });
});

describe("isSellable keeps a product that cannot be priced out of the cart", () => {
  it("a real product with a variantId is sellable", () => {
    expect(isSellable(product({ variantId: UUID_B }))).toBe(true);
  });

  it("a real product with production variants but no default variantId is sellable", () => {
    expect(
      isSellable(
        product({
          productionVariants: [{ variantId: UUID_B, name: "S", sku: "S", price: usd(500) }],
        }),
      ),
    ).toBe(true);
  });

  it("ADVERSARIAL: a real product with NO sellable variant is not sellable", () => {
    expect(isSellable(product())).toBe(false);
  });

  it("a prototype product is always sellable — it only ever reaches the prototype checkout", () => {
    expect(isSellable(product({ id: "prd-1" }))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. NO FAKE SUCCESS — structural guards
// ═══════════════════════════════════════════════════════════════════════════

describe("The fabricating sale path cannot be reached with production data", () => {
  const api = readSource(API_INDEX);

  it("ADVERSARIAL: createSale throws rather than fabricating a sale for a production product id", () => {
    const fn = api.slice(
      api.indexOf("export async function createSale"),
      api.indexOf("/* --------------------- Phase 4"),
    );
    expect(fn).toContain("isProductionId(item.productId)");
    expect(fn).toContain("throw new Error");
    expect(fn).toContain("isProductionId(input.customerId)");
  });

  it("createSale is documented as prototype-only, not as a fallback", () => {
    const doc = api.slice(
      api.indexOf("PROTOTYPE-ONLY sale creation"),
      api.indexOf("export async function createSale"),
    );
    expect(doc).toContain("Never reachable with production data");
  });

  it("ADVERSARIAL: POS refuses an unsellable cart instead of rendering a success state for it", () => {
    const source = readSource(CHECKOUT_SHEET);
    const branch = source.slice(
      source.indexOf('checkoutKind === "unsellable"'),
      source.indexOf(") : isRealCheckout ? ("),
    );
    expect(branch).toContain("pos.unsellable.title");
    // The refusal branch offers no way to complete a sale.
    expect(branch).not.toContain("createSale");
    expect(branch).not.toContain("completeReal");
  });

  it("ADVERSARIAL: POS never renders a success surface before the server has answered", () => {
    const source = readSource(CHECKOUT_SHEET);
    // Both success surfaces are gated on server-returned state (a Sale object
    // or a RealOrderDetail), never on a submitting/optimistic flag.
    expect(source).toContain("{sale ? (");
    expect(source).toContain(") : realDetail ? (");
    expect(source).not.toMatch(/submitting\s*\?\s*<motion\.div[\s\S]{0,80}role="status"/);
  });

  it("ADVERSARIAL: the order code shown after a real sale is the server's, never built in the browser", () => {
    const source = readSource(CHECKOUT_SHEET);
    expect(source).toContain("{realDetail.order.code}");
    expect(source).not.toMatch(/`APSA-\$\{/);
  });

  it("ADVERSARIAL: a real product with no variant cannot enter the cart at all", () => {
    const route = readSource(POS_ROUTE);
    const fn = route.slice(
      route.indexOf("function selectProduct"),
      route.indexOf("function resetSale"),
    );
    expect(fn).toContain("if (!isSellable(product)) return;");
    // The guard runs before anything that could add a line.
    expect(fn.indexOf("isSellable")).toBeLessThan(fn.indexOf("addProduct"));
  });

  it("an unsellable product is disabled in the catalog and says why", () => {
    const list = readSource(PRODUCT_LIST);
    expect(list).toContain("isSellable(product)");
    expect(list).toContain('state === "out_of_stock" || !sellable');
    expect(list).toContain("pos.unsellable.noVariant");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. PAYMENT SEMANTICS — nothing is inferred from anything else
// ═══════════════════════════════════════════════════════════════════════════

describe("Payment truth is never inferred from order or delivery state", () => {
  const source = readSource(CHECKOUT_SHEET);
  const detail = readSource(ORDER_DETAIL);

  it("ADVERSARIAL: order confirmation is never mapped to paid", () => {
    // The confirmed real-order success surface states the payment axis from
    // the server and says out loud that payment is still outstanding.
    expect(source).toContain("pos.success.unpaidNote");
    expect(source).toContain("<StatusChip status={realDetail.order.paymentStatus} />");
    expect(source).not.toMatch(/realConfirmed[\s\S]{0,60}paymentStatus\s*=\s*"paid"/);
  });

  it("ADVERSARIAL: the payment action is gated on the server's unpaid axis, not on lifecycle", () => {
    expect(source).toContain('realDetail.order.paymentStatus === "unpaid"');
  });

  it("ADVERSARIAL: COD is never treated as paid — it keeps its own permission", () => {
    expect(source).toContain('capabilities.can("payments.mark_cod")');
    expect(source).toContain("canMarkCod={canMarkCod}");
    // COD is a separate grant from recording, exactly as the server requires.
    expect(source).toContain('capabilities.can("payments.record")');
  });

  it("ADVERSARIAL: recording a payment re-reads the order instead of asserting a status locally", () => {
    const fn = source.slice(
      source.indexOf("const recordPaymentMutation"),
      source.indexOf("// COD is only sensible"),
    );
    expect(fn).toContain("getRealOrderDetail");
    expect(fn).not.toContain('paymentStatus: "paid"');
  });

  it("ADVERSARIAL: delivery existence is never read as payment truth", () => {
    // Order detail derives its payment surface from the payment ledger and
    // settlement RPC only — no delivery field appears in that decision.
    expect(detail).not.toMatch(/delivery[\s\S]{0,40}paymentStatus\s*=/i);
    expect(detail).not.toMatch(/paymentStatus[\s\S]{0,40}=\s*delivery/i);
  });

  it("ADVERSARIAL: uploaded evidence is never mapped to a verified payment", () => {
    const payments = readSource("src/lib/payments.ts");
    // Evidence and verificationState are carried as independent fields off the
    // server row. Nothing derives one from the presence of the other.
    expect(payments).toContain("verificationState: row.verificationState");
    expect(payments).not.toMatch(/verificationState\s*[:=]\s*[^;\n]*evidence/i);
    expect(payments).not.toMatch(/evidence[^;\n]{0,40}\?\s*"verified"/i);
  });

  it("ADVERSARIAL: a refund is never collapsed into unpaid — it is its own axis", () => {
    const payments = readSource("src/lib/payments.ts");
    expect(payments).toContain("refundStatus: row.refundStatus");
    // The order's payment axis and refund axis are read separately from SQL;
    // a refund never rewrites paymentStatus here.
    expect(payments).toContain("paymentStatus");
    expect(payments).not.toMatch(/paymentStatus\s*[:=]\s*[^;\n]*refund/i);
  });

  it("settlement figures come from the server's own RPC, never recomputed in the browser", () => {
    expect(detail).toContain("getRealOrderSettlement");
    expect(detail).not.toMatch(/parseFloat|Number\([^)]*\)\s*\*\s*100/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. MONEY SAFETY
// ═══════════════════════════════════════════════════════════════════════════

describe("Money stays integer minor units across the sale journey", () => {
  for (const file of [CHECKOUT_SHEET, POS_ROUTE, CREATE_ORDER_SHEET, ORDER_DETAIL]) {
    it(`ADVERSARIAL: ${file} performs no floating-point money arithmetic`, () => {
      const source = readSource(file);
      expect(source).not.toContain("parseFloat");
      expect(source).not.toMatch(/\.toFixed\(2\)/);
      expect(source).not.toMatch(/\*\s*100(?![\d])/);
      expect(source).not.toMatch(/\/\s*100(?![\d])/);
    });
  }

  it("the POS checkout never sends a price, subtotal or total to the server", () => {
    const source = readSource(CHECKOUT_SHEET);
    const fn = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    for (const forbidden of ["unitPrice", "subtotal:", "total:", "organizationId", "userId"]) {
      expect(fn).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. CACHE CONTINUITY — no stale surface after a real mutation
// ═══════════════════════════════════════════════════════════════════════════

describe("Every sale mutation refreshes the surfaces it makes stale", () => {
  const source = readSource(CHECKOUT_SHEET);
  const detail = readSource(ORDER_DETAIL);

  it("ADVERSARIAL: a POS sale invalidates Orders, Payments and Home for this principal", () => {
    const fn = source.slice(
      source.indexOf("function invalidateAfterSale"),
      source.indexOf("const recordPaymentMutation"),
    );
    expect(fn).toContain("ordersKeys.principal(userId, organizationId)");
    expect(fn).toContain('["payments", userId, organizationId]');
    expect(fn).toContain("HOME_QUERY_PREFIX");
  });

  it("ADVERSARIAL: cache keys stay partitioned by BOTH user and organization", () => {
    // A bare, unpartitioned sensitive key would serve one principal's orders
    // to the next one signing in to the same tab.
    expect(source).not.toMatch(/invalidateQueries\(\{\s*queryKey:\s*\["orders"\]/);
    expect(source).not.toMatch(/invalidateQueries\(\{\s*queryKey:\s*\["payments"\]\s*\}/);
    expect(source).toContain("userId, organizationId");
  });

  it("the sale invalidates on create AND on confirm, not only at the end", () => {
    const fn = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    expect(fn.match(/invalidateAfterSale\(\)/g)?.length).toBe(2);
  });

  it("ADVERSARIAL: recording a payment from POS refreshes Home attention", () => {
    const fn = source.slice(
      source.indexOf("const recordPaymentMutation"),
      source.indexOf("// COD is only sensible"),
    );
    expect(fn).toContain("invalidateAfterSale()");
  });

  it("ADVERSARIAL: an order lifecycle change refreshes the list and Home, not only the detail", () => {
    const fn = detail.slice(
      detail.indexOf("function invalidateAfterLifecycleChange"),
      detail.indexOf("const confirmMutation"),
    );
    expect(fn).toContain("ordersKeys.list(userId, routeOrganizationId)");
    expect(fn).toContain("HOME_QUERY_PREFIX");
    expect(detail).toMatch(/confirmMutation[\s\S]{0,400}invalidateAfterLifecycleChange\(\)/);
    expect(detail).toMatch(/cancelMutation[\s\S]{0,400}invalidateAfterLifecycleChange\(\)/);
  });

  it("arranging delivery refreshes the order it belongs to, not just the deliveries sub-key", () => {
    const fn = detail.slice(
      detail.indexOf("<CreateDeliverySheet"),
      detail.indexOf("<RecordOrderPaymentSheet"),
    );
    expect(fn).toContain("deliveriesQueryKey");
    expect(fn).toContain("invalidateAfterLifecycleChange()");
  });

  it("creating an order from the Orders list refreshes Home attention too", () => {
    const list = readSource(ORDER_LIST);
    const fn = list.slice(list.indexOf("<CreateRealOrderSheet"), list.indexOf("<BottomNav"));
    expect(fn).toContain("listKey");
    expect(fn).toContain("HOME_QUERY_PREFIX");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. CONTINUITY — every success leads somewhere real
// ═══════════════════════════════════════════════════════════════════════════

describe("A completed sale hands the merchant to the real record", () => {
  it("POS success links to the real order by its server id", () => {
    const source = readSource(CHECKOUT_SHEET);
    expect(source).toContain("href={`/app/orders/${realDetail.order.id}`}");
  });

  it("ADVERSARIAL: manual order creation no longer auto-closes onto nothing", () => {
    const sheet = readSource(CREATE_ORDER_SHEET);
    expect(sheet).not.toContain("window.setTimeout");
    expect(sheet).toContain("href={`/app/orders/${created.id}`}");
    expect(sheet).toContain("orderCreate.viewOrder");
  });

  it("manual order creation shows the server's own payment axis, not a success-implies-paid claim", () => {
    const sheet = readSource(CREATE_ORDER_SHEET);
    expect(sheet).toContain("t(`status.${created.paymentStatus}`)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. PERMISSIONS — offered vs allowed
// ═══════════════════════════════════════════════════════════════════════════

describe("Payment actions are offered on capability and allowed by the server", () => {
  const source = readSource(CHECKOUT_SHEET);

  it("ADVERSARIAL: the POS payment action is capability-gated", () => {
    expect(source).toContain("canRecordPayment");
    expect(source).toMatch(/paymentStatus === "unpaid" && canRecordPayment/);
  });

  it("POS introduces no new permission key — it reuses the two the server already requires", () => {
    const keys = [...source.matchAll(/capabilities\.can\("([^"]+)"\)/g)].map((m) => m[1]);
    for (const key of keys) {
      expect(["payments.record", "payments.mark_cod"]).toContain(key);
    }
  });

  it("the client never sends an organization id — the server derives it from the session", () => {
    const fn = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    expect(fn).not.toContain("organizationId");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. IDEMPOTENCY / RETRY
// ═══════════════════════════════════════════════════════════════════════════

describe("Retry never duplicates an order or a payment", () => {
  const source = readSource(CHECKOUT_SHEET);

  it("ADVERSARIAL: a double tap cannot start two submissions", () => {
    const fn = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    expect(fn).toContain("if (submittingRef.current) return;");
    // The guard is synchronous — set before the first await.
    expect(fn.indexOf("submittingRef.current = true")).toBeLessThan(fn.indexOf("await"));
  });

  it("ADVERSARIAL: retrying after a failed confirm never creates a second order", () => {
    const fn = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    expect(fn).toContain("let orderId = createdOrderId;");
    expect(fn).toContain("if (!orderId) {");
  });

  it("ADVERSARIAL: every payment attempt carries an idempotency key", () => {
    expect(source).toContain("idempotencyKey: submit.idempotencyKey");
  });

  it("a failed sale keeps the cart — merchant work is never discarded on an unknown outcome", () => {
    const fn = source.slice(
      source.indexOf("async function completeReal"),
      source.indexOf("const realConfirmed"),
    );
    // onCompleted() (which clears the cart) runs ONLY after the order exists.
    expect(fn.indexOf("onCompleted()")).toBeGreaterThan(fn.indexOf("setCreatedOrderId(orderId)"));
    const katch = fn.slice(fn.indexOf("} catch"));
    expect(katch).not.toContain("onCompleted()");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I. ERROR STATES
// ═══════════════════════════════════════════════════════════════════════════

describe("Failure never renders as success", () => {
  const source = readSource(CHECKOUT_SHEET);

  it("ADVERSARIAL: a failed real sale shows a retryable error, not a celebration", () => {
    expect(source).toContain("realFailure");
    expect(source).toContain("onRetry={() => void completeReal()}");
    // realDetail is only ever set from a server response.
    const sets = [...source.matchAll(/setRealDetail\(([^;]*?)\);/g)].map((m) => m[1].trim());
    expect(sets.length).toBeGreaterThan(0);
    for (const arg of sets) {
      // Only a server response, or an explicit reset. Never a locally
      // assembled order object.
      expect([
        "created",
        "confirmed",
        "null",
        "await getRealOrderDetail(realDetail!.order.id)",
      ]).toContain(arg);
    }
  });

  it("a permission denial is reported as a permission problem, not a server failure", () => {
    expect(source).toContain(
      'classifyOrderError(error) === "forbidden" ? "permission" : "generic"',
    );
    expect(source).toContain("pos.permission.title");
  });

  it("the record-payment error is classified, not shown as a generic crash", () => {
    expect(source).toContain("paymentErrorKey(classifyPaymentError(recordPaymentMutation.error))");
  });
});

/**
 * POS must not tell a merchant they are someone else.
 *
 * The POS header's subtitle was `localName(shopQuery.data)`, and shopQuery ran
 * `getActiveShop()` — which resolves against src/lib/mock/shop.ts
 * unconditionally, with no server call and no demo-mode gate. Every real
 * merchant, on every real till, was therefore labelled "ហាងស្រីនាង /
 * Sreyneang Shop": a fixture business name printed over a production sale
 * surface.
 *
 * The honest fix is no subtitle. The real name lives behind
 * getOrganizationProfileFn, which requires `organization.read` — a permission
 * cashiers deliberately do not have — so POS cannot show it without inventing
 * a parallel data path, and showing nothing is true while showing a fixture is
 * not.
 */
describe("POS carries no fixture identity", () => {
  const source = readSource(POS_ROUTE);

  it("does not call the fixture shop lookup", () => {
    expect(source).not.toContain("getActiveShop");
  });

  it("renders no shop subtitle rather than a fabricated one", () => {
    expect(source).not.toMatch(/subtitle=\{shopQuery/);
    expect(source).not.toContain("shopQuery");
  });

  it("reaches the mock catalogue module nowhere", () => {
    expect(source).not.toContain("@/lib/mock");
  });
});
