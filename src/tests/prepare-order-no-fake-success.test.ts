/**
 * Inbox → Prepare Order: no fabricated order, ever.
 *
 * The hole this pins is the exact counterpart of the POS one that
 * src/tests/merchant-sale-journey.test.ts guards, in the other order-creation
 * path — and it survived that phase.
 *
 * PrepareOrderSheet.submit() asked ONE two-way question:
 *
 *     useRealOrders = channelToSourceDb(channel) !== null
 *                     && isProductionId(customer.id)
 *                     && readyLines.every(isProductionReady)
 *
 * and on `false` ran the LOCAL path — createOrder(), which mints an
 * `APSA-00NN` code in the browser, returns fulfillmentStatus "confirmed", and
 * persists nothing. The sheet then showed the merchant that code as a success
 * and the conversation route appended a system message reading
 * "Order APSA-00NN created" to the real thread.
 *
 * Two ordinary production situations took that false branch:
 *
 *   1. a real conversation whose channel is "other" — channelToSourceDb
 *      returns null by design, because no DB source enum member honestly
 *      means "unclassified";
 *   2. a real catalog product with no ACTIVE variant — mapServerProductToUi
 *      leaves variantId unset, so isProductionReady was false.
 *
 * In both, a merchant with a real customer and real goods was told an order
 * existed when none did. classifyPreparedOrder replaces the two-way test with
 * the same three-way one POS uses, and createOrder now carries createSale's
 * structural guard so the local path cannot accept production data even if the
 * routing is weakened again.
 *
 * Run: bun test src/tests/prepare-order-no-fake-success.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  classifyPreparedOrder,
  explainUnsellablePreparedOrder,
  type PreparedOrderInput,
} from "@/lib/orders";
import { createOrder } from "@/lib/api";
import { usd } from "@/lib/money";
import type { OrderItem } from "@/types";

const ROOT = process.cwd();
const readSource = (p: string) => fs.readFileSync(path.resolve(ROOT, p), "utf-8");

const PREPARE_SHEET = "src/components/inbox/PrepareOrderSheet.tsx";
const API_INDEX = "src/lib/api/index.ts";

const PRODUCT = "3f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";
const VARIANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CUSTOMER = "11111111-2222-3333-4444-555555555555";

function prepared(over: Partial<PreparedOrderInput> = {}): PreparedOrderInput {
  return {
    channel: "facebook",
    customerId: CUSTOMER,
    lines: [{ productId: PRODUCT, variantId: VARIANT }],
    ...over,
  };
}

describe("classifyPreparedOrder — the three-way routing decision", () => {
  it("routes a fully production draft to the real Order domain", () => {
    expect(classifyPreparedOrder(prepared())).toBe("production");
  });

  it("accepts every writable channel", () => {
    for (const channel of ["facebook", "instagram", "telegram", "pos"] as const) {
      expect(classifyPreparedOrder(prepared({ channel }))).toBe("production");
    }
  });

  it("REFUSES a real draft on an unclassified channel instead of faking it", () => {
    // Regression #1. This used to return the equivalent of "prototype" and
    // mint an order code for a real customer and real goods.
    expect(classifyPreparedOrder(prepared({ channel: "other" }))).toBe("unsellable");
  });

  it("REFUSES a real product that carries no sellable variant", () => {
    // Regression #2 — the variantless catalog row.
    for (const variantId of [null, undefined, ""]) {
      expect(classifyPreparedOrder(prepared({ lines: [{ productId: PRODUCT, variantId }] }))).toBe(
        "unsellable",
      );
    }
  });

  it("REFUSES a draft mixing real and fixture goods", () => {
    expect(
      classifyPreparedOrder(
        prepared({
          lines: [
            { productId: PRODUCT, variantId: VARIANT },
            { productId: "prd-1", variantId: null },
          ],
        }),
      ),
    ).toBe("unsellable");
  });

  it("REFUSES a real customer whose lines are all fixture products", () => {
    expect(classifyPreparedOrder(prepared({ lines: [{ productId: "prd-1" }] }))).toBe("unsellable");
  });

  it("REFUSES an empty draft rather than creating a zero-line order", () => {
    expect(classifyPreparedOrder(prepared({ lines: [] }))).toBe("unsellable");
  });

  it("still allows the pure prototype path for the design catalogue", () => {
    expect(
      classifyPreparedOrder({
        channel: "facebook",
        customerId: "cus-1",
        lines: [{ productId: "prd-1" }, { productId: "prd-2" }],
      }),
    ).toBe("prototype");
  });

  it("never calls a draft prototype merely because the customer is a fixture", () => {
    // A fixture customer with REAL goods is not a prototype draft — creating a
    // fabricated order would still take real stock off a real catalogue row in
    // the merchant's mind.
    expect(
      classifyPreparedOrder({
        channel: "facebook",
        customerId: "cus-1",
        lines: [{ productId: PRODUCT, variantId: VARIANT }],
      }),
    ).toBe("unsellable");
  });
});

describe("explainUnsellablePreparedOrder — tells the merchant the actionable thing", () => {
  it("names the missing variant when a real line has none", () => {
    expect(
      explainUnsellablePreparedOrder(
        prepared({ lines: [{ productId: PRODUCT, variantId: null }] }),
      ),
    ).toBe("no-variant");
  });

  it("names the channel when that is the only blocker", () => {
    expect(explainUnsellablePreparedOrder(prepared({ channel: "other" }))).toBe(
      "unwritable-channel",
    );
  });

  it("prefers the variant explanation, which is the one the merchant can fix", () => {
    expect(
      explainUnsellablePreparedOrder(
        prepared({ channel: "other", lines: [{ productId: PRODUCT, variantId: null }] }),
      ),
    ).toBe("no-variant");
  });

  it("falls back to the mixed-catalogue explanation", () => {
    expect(
      explainUnsellablePreparedOrder({
        channel: "facebook",
        customerId: "cus-1",
        lines: [{ productId: PRODUCT, variantId: VARIANT }],
      }),
    ).toBe("mixed");
  });
});

describe("createOrder — structural refusal of production data", () => {
  const line = (productId: string): OrderItem => ({
    productId,
    nameKm: "សាកល្បង",
    nameEn: "Test",
    quantity: 1,
    unitPrice: usd(10),
  });

  const input = (productId: string, customerId: string) => ({
    customerId,
    channel: "facebook" as const,
    items: [line(productId)],
    subtotal: usd(10),
    discount: usd(0),
    deliveryFee: usd(0),
    total: usd(10),
  });

  it("throws rather than fabricate an order for a production product id", async () => {
    await expect(createOrder(input(PRODUCT, "cus-1"))).rejects.toThrow(/prototype-only/i);
  });

  it("throws rather than fabricate an order for a production customer id", async () => {
    await expect(createOrder(input("prd-1", CUSTOMER))).rejects.toThrow(/prototype-only/i);
  });

  it("names createRealOrder in the error, so the fix is obvious at the call site", async () => {
    await expect(createOrder(input(PRODUCT, CUSTOMER))).rejects.toThrow(/createRealOrder/);
  });

  it("still serves the prototype catalogue it exists for", async () => {
    const order = await createOrder(input("prd-1", "cus-1"));
    expect(order.code).toMatch(/^APSA-\d{4}$/);
  });
});

describe("PrepareOrderSheet wiring — the refusal is reachable, not just defined", () => {
  const source = readSource(PREPARE_SHEET);

  it("classifies the draft before choosing a creation path", () => {
    expect(source).toContain("classifyPreparedOrder");
  });

  it("returns without creating anything when the draft is unsellable", () => {
    const submit = source.slice(source.indexOf("async function submit()"));
    const guard = submit.indexOf('kind === "unsellable"');
    expect(guard).toBeGreaterThan(-1);
    // The refusal must come BEFORE either creation call in the function body.
    expect(guard).toBeLessThan(submit.indexOf("createRealOrder("));
    expect(guard).toBeLessThan(submit.indexOf("createOrder("));
  });

  it("reaches the local path only on an explicit prototype classification", () => {
    // Not `else` by elimination — that is precisely the shape of the old bug.
    expect(source).not.toMatch(/const\s+useRealOrders\s*=/);
    expect(source).toContain('if (kind === "production")');
  });

  it("shows the merchant a reason rather than a generic failure", () => {
    expect(source).toContain("explainUnsellablePreparedOrder");
    expect(source).toContain("conversation.prepareOrder.unsellable.title");
  });

  it("offers no retry on a refusal, because retrying changes nothing", () => {
    const blockerBlock = source.slice(
      source.indexOf("{blocker ? ("),
      source.indexOf("{failure ? ("),
    );
    expect(blockerBlock).not.toContain("onRetry");
  });

  it("no longer carries the two-way helper that degraded silently", () => {
    expect(source).not.toContain("isProductionReady");
  });
});

describe("no fabricated-order path survives in the API layer", () => {
  const api = readSource(API_INDEX);

  it("documents createOrder as prototype-only, like createSale", () => {
    const fn = api.slice(api.indexOf("export async function createOrder"));
    expect(api.slice(0, api.indexOf("export async function createOrder"))).toContain(
      "PROTOTYPE-ONLY order creation",
    );
    expect(fn.slice(0, 600)).toContain("isProductionId");
  });
});

describe("Prepare Order never guesses between multiple production variants", () => {
  // Regression: mapServerProductToUi sets `variantId` to the first ACTIVE
  // variant only, and PrepareOrderSheet used to submit `line.product.variantId`
  // straight through with no picker of its own — unlike PosVariantSheet, which
  // explicitly refuses to pre-select ("Do not guess between multiple
  // variants"). A merchant preparing an order for a product with 2+ ACTIVE
  // variants (e.g. a T-shirt in several colors/sizes) got whichever variant
  // the server happened to return first, silently, with no warning and
  // nothing in the UI showing a choice was skipped.
  const source = readSource(PREPARE_SHEET);

  it("tracks a per-line variantId separately from the product's default one", () => {
    expect(source).toMatch(/variantId:\s*string\s*\|\s*null/);
    // The rule itself now lives in @/lib/order-draft, shared with
    // CreateRealOrderSheet so the two order sheets cannot drift apart on it
    // (behaviour is executed in src/tests/create-real-order-variant.test.ts).
    // What matters here is that this sheet seeds every line THROUGH that rule
    // rather than reaching for the product's first-ACTIVE-variant default.
    expect(source).toMatch(/from "@\/lib\/order-draft"/);
    expect(source).toMatch(/needsVariantChoice/);
    expect(source).toMatch(/variantId: defaultProductVariantId\(input\.product \?\? null\)/);
    expect(source).toMatch(/variantId: defaultProductVariantId\(product\)/);
    expect(source).not.toMatch(/variantId: product\.variantId/);
  });

  it("renders a chooser for a multi-variant line instead of the mock option chips", () => {
    expect(source).toMatch(/needsVariantChoice\(line\.product\)/);
    expect(source).toMatch(/line\.product\.productionVariants!\.map/);
  });

  it("submit is blocked until a multi-variant line has an explicit choice", () => {
    const fn = source.slice(
      source.indexOf("const readyToSubmit ="),
      source.indexOf("const estimatedTotal"),
    );
    expect(fn).toMatch(/needsVariantChoice\(line\.product!\)/);
    expect(fn).toMatch(/Boolean\(line\.variantId\)/);
  });

  it("the real order is created with the CHOSEN variant, never product.variantId directly", () => {
    const fn = source.slice(
      source.indexOf("async function submit"),
      source.indexOf("async function confirm"),
    );
    expect(fn).toMatch(/variantId:\s*line\.variantId/);
    expect(fn).not.toMatch(/variantId:\s*line\.product\.variantId/);
  });
});

describe("Prepare Order's submit button is pinned, not scrollable out of reach", () => {
  // Regression: the "Create Draft"/"Create Order" button used to sit inline
  // in the scrollable body. With 2+ item cards, or the product-search field's
  // own focus scroll-into-view, it could scroll out of reach on a small
  // viewport — exactly what BottomSheet's `footer` slot exists to prevent
  // (see its own comment; CreateProductSheet/EditBusinessProfileSheet already
  // use it for the same reason).
  const source = readSource(PREPARE_SHEET);

  const bodyStart = source.indexOf('<div className="space-y-5 pb-4">');

  it("passes the review step's submit button through BottomSheet's footer prop", () => {
    const footerBlock = source.slice(source.indexOf("footer={"), bodyStart);
    expect(footerBlock).toContain('step.name === "review"');
    expect(footerBlock).toMatch(/onClick=\{\(\) => void submit\(\)\}/);
  });

  it("the button is no longer duplicated inline in the scrollable review body", () => {
    const reviewBody = source.slice(bodyStart, source.indexOf('step.name === "created-mock"'));
    expect(reviewBody).not.toMatch(/onClick=\{\(\) => void submit\(\)\}/);
  });
});
