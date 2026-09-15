/**
 * Apsi's FIND layer — orchestration only.
 *
 * Every fact on this page comes from the domain that owns it. Apsi calls the
 * existing `@/lib/api` boundary functions (which call the existing server
 * functions, which re-authorize on every request) and arranges the answers
 * into cards. It holds no data of its own, adds no query, derives no status,
 * and computes no money. There is no "Apsi database".
 *
 * Two rules shape the whole module:
 *
 *   1. PERMISSION-AWARE BEFORE THE REQUEST. A probe the member has no
 *      capability bit for is never issued, so sensitive data is not fetched
 *      and then hidden in the browser. The capability snapshot is presentation
 *      data — the server re-checks the same key with `ctx.require` regardless,
 *      and would refuse. Skipping here is about not asking, not about access.
 *
 *   2. NEVER INVENT. A probe that fails is reported as a failure, a probe that
 *      finds nothing is reported as nothing, and a fact the domain withheld
 *      (a customer phone behind `customers.view_sensitive`) stays withheld.
 *      Apsi says it cannot confirm something rather than filling the gap.
 *
 * Safe to bundle for the browser: `@/lib/api` and `@/lib/inventory` are the
 * client-side boundary, and both reach the server only through dynamically
 * imported server functions.
 */
import {
  getCustomer360,
  getRealDeliveryDetail,
  getRealOrderDetail,
  getRealPaymentDetail,
  listRealDeliveries,
  lookupProductByBarcode,
  lookupProductBySku,
  lookupRealOrderByCode,
  searchRealCustomers,
} from "@/lib/api";
import { getVariantStock } from "@/lib/inventory";
import type { UiPermissionKey } from "@/lib/capabilities";
import type { Money } from "@/types";
import type { PaymentStatus, PaymentVerificationState } from "@/lib/payments";
import type { RealDeliveryStatus } from "@/lib/deliveries";
import type { ApsiProbe, ApsiProbeKind, ApsiQueryPlan } from "./input";

/**
 * Every capability key a probe's own server function requires. ALL of them
 * must hold, or the probe is not issued.
 *
 * A list rather than a single key because of one entry: the customer phone
 * search needs `customers.read` AND `customers.view_sensitive`, and the second
 * is not optional decoration on the first. WHICH CUSTOMERS COME BACK for a
 * typed phone fragment is the disclosure that `customers.view_sensitive`
 * gates — blanking the digits afterwards still leaves the console answering
 * "does a customer with this number exist here?". So the grant is checked
 * before the request exists, not applied to its result.
 */
export const APSI_PROBE_PERMISSIONS: Readonly<Record<ApsiProbeKind, readonly UiPermissionKey[]>> = {
  "order-by-id": ["orders.read"],
  "order-by-code": ["orders.read"],
  "payment-by-id": ["payments.read"],
  "delivery-by-id": ["delivery.read"],
  "customer-by-id": ["customers.read"],
  "customer-by-name": ["customers.read"],
  "customer-by-phone": ["customers.read", "customers.view_sensitive"],
  "product-by-barcode": ["products.read"],
  "product-by-sku": ["products.read"],
  "delivery-search": ["delivery.read"],
};

/** How many delivery matches one console answer shows before it says "open the hub". */
export const APSI_DELIVERY_RESULT_LIMIT = 5;

/** How many customer matches one console answer shows. Apsi is a finder, not a CRM list. */
export const APSI_CUSTOMER_RESULT_LIMIT = 5;

// ── Result cards ──────────────────────────────────────────────────────────────

export interface ApsiOrderResult {
  kind: "order";
  id: string;
  code: string;
  total: Money;
  lifecycleStatus: string | null;
  paymentStatus: string;
  fulfillmentStatus: string;
}

export interface ApsiPaymentResult {
  kind: "payment";
  id: string;
  orderId: string;
  amount: Money;
  status: PaymentStatus;
  verificationState: PaymentVerificationState;
}

export interface ApsiDeliveryResult {
  kind: "delivery";
  id: string;
  orderId: string;
  /** null when the member cannot read the owning order, or it no longer exists. */
  orderCode: string | null;
  status: RealDeliveryStatus;
  providerName: string;
  trackingNumber: string | null;
  /** null unless the SERVER included it — it withholds this without customers.read. */
  customerName: string | null;
}

export interface ApsiCustomerResult {
  kind: "customer";
  id: string;
  name: string;
  /** "" whenever the server withheld it (no customers.view_sensitive). Never reconstructed. */
  phone: string;
  /** Server-authoritative: false means the payload was built with PII withheld. */
  sensitiveVisible: boolean;
  /**
   * null when this card came from the customer SEARCH, which is a finder read
   * and returns no order history. Rendered only when non-null: printing "0
   * orders" for a customer whose history was never loaded is a CRM fact Apsi
   * does not have, and a merchant would read it as "this person never bought
   * anything".
   */
  orderCount: number | null;
  lastPurchaseAt: string | null;
}

export interface ApsiProductResult {
  kind: "product";
  id: string;
  variantId: string | null;
  name: string;
  sku: string;
  barcode: string | null;
  price: Money;
  /**
   * Stock is an Inventory-domain fact, fetched separately and only with
   * inventory.read. `null` means "not asked / not answered", never "zero" —
   * a ledger balance is never guessed from a catalogue row.
   */
  stock: number | null;
}

export type ApsiResult =
  ApsiOrderResult | ApsiPaymentResult | ApsiDeliveryResult | ApsiCustomerResult | ApsiProductResult;

/** A probe that was not run, and why. */
export interface ApsiSkippedProbe {
  kind: ApsiProbeKind;
  permission: UiPermissionKey;
}

/** A probe that ran and failed. Reported, never smoothed over. */
export interface ApsiFailedProbe {
  kind: ApsiProbeKind;
}

export interface ApsiLookupOutcome {
  results: readonly ApsiResult[];
  /** Probes withheld because the member holds no supported access to that domain. */
  skipped: readonly ApsiSkippedProbe[];
  /** Probes that ran and errored — the console must not read this as "nothing found". */
  failed: readonly ApsiFailedProbe[];
  /** True when at least one probe actually reached its domain and answered. */
  answered: boolean;
  /**
   * True when a domain said there is more than it returned — another page of
   * customer matches, or a scan that hit its bound. A PARTIAL answer is not a
   * complete one, and the console must not let a merchant read five results as
   * "these are all of them".
   */
  incomplete: boolean;
}

export interface ApsiGrants {
  can(key: UiPermissionKey): boolean;
}

export interface ApsiLookupPlan {
  runnable: readonly ApsiProbe[];
  skipped: readonly ApsiSkippedProbe[];
}

/**
 * Split the classifier's probes into the ones this member may run and the ones
 * that are withheld. Pure, so the console can render the withheld set without
 * issuing a single request.
 */
export function planApsiLookup(plan: ApsiQueryPlan, grants: ApsiGrants): ApsiLookupPlan {
  const runnable: ApsiProbe[] = [];
  const skipped: ApsiSkippedProbe[] = [];

  for (const probe of plan.probes) {
    const required = APSI_PROBE_PERMISSIONS[probe.kind];
    // EVERY key, not any: the phone search holds two, and satisfying only
    // customers.read would issue exactly the query customers.view_sensitive
    // exists to prevent.
    const missing = required.find((key) => !grants.can(key));
    if (missing === undefined) runnable.push(probe);
    // The FIRST missing key is what the member is told about — the one they
    // would need to be granted next, rather than a list they cannot act on.
    else skipped.push({ kind: probe.kind, permission: missing });
  }

  return { runnable, skipped };
}

// ── Execution ─────────────────────────────────────────────────────────────────

/**
 * A single probe's answer: a list of cards (possibly empty), or a failure.
 *
 * "Not found" and "failed" are kept apart all the way to the screen. Collapsing
 * them is how a console starts telling a merchant an order does not exist when
 * the truth is that the request did not complete.
 */
type ProbeOutcome = { ok: true; results: ApsiResult[]; incomplete?: boolean } | { ok: false };

async function runProbe(probe: ApsiProbe, grants: ApsiGrants): Promise<ProbeOutcome> {
  try {
    switch (probe.kind) {
      case "order-by-id": {
        const detail = await getRealOrderDetail(probe.id);
        return {
          ok: true,
          results: [
            {
              kind: "order",
              id: detail.order.id,
              code: detail.order.code,
              total: detail.order.total,
              lifecycleStatus: detail.order.lifecycleStatus ?? null,
              paymentStatus: detail.order.paymentStatus,
              fulfillmentStatus: detail.order.fulfillmentStatus,
            },
          ],
        };
      }

      case "order-by-code": {
        /*
         * The Orders domain, asked about an order — not the Delivery list's
         * free-text search, which was the only path to an order code before
         * and could not see an order that had no delivery row.
         *
         * `null` is a real answer ("no order carries this code"), so it is an
         * empty result set, not a failure. The id on the summary is the
         * production order id, which is what the card routes with.
         */
        const order = await lookupRealOrderByCode(probe.value);
        if (!order) return { ok: true, results: [] };
        return {
          ok: true,
          results: [
            {
              kind: "order",
              id: order.id,
              code: order.code,
              total: order.total,
              lifecycleStatus: order.lifecycleStatus ?? null,
              paymentStatus: order.paymentStatus,
              fulfillmentStatus: order.fulfillmentStatus,
            },
          ],
        };
      }

      case "payment-by-id": {
        const payment = await getRealPaymentDetail(probe.id);
        return {
          ok: true,
          results: [
            {
              kind: "payment",
              id: payment.id,
              orderId: payment.orderId,
              amount: payment.amount,
              status: payment.status,
              verificationState: payment.verificationState,
            },
          ],
        };
      }

      case "delivery-by-id": {
        const detail = await getRealDeliveryDetail(probe.id);
        return {
          ok: true,
          results: [
            {
              kind: "delivery",
              id: detail.id,
              orderId: detail.orderId,
              // The detail read is delivery-scoped; the order code belongs to
              // the Order domain and is not fetched here rather than guessed.
              orderCode: null,
              status: detail.status,
              providerName: detail.providerName,
              trackingNumber: detail.externalTrackingNumber,
              customerName: null,
            },
          ],
        };
      }

      case "customer-by-id": {
        const view = await getCustomer360(probe.id);
        const customer = view.customer;
        return {
          ok: true,
          results: [
            {
              kind: "customer",
              id: customer.id,
              name: customer.nameKm || customer.nameEn,
              phone: customer.phone,
              sensitiveVisible: customer.sensitiveVisible !== false,
              orderCount: customer.orderCount,
              lastPurchaseAt: customer.lastPurchaseAt ?? null,
            },
          ],
        };
      }

      case "customer-by-name":
      case "customer-by-phone": {
        /*
         * One server contract for both, because the difference between them is
         * the server's to decide: it reads the shape of the query and the
         * caller's own grants, and answers which column it actually matched.
         * A probe kind here is a ROUTING decision, never an instruction to the
         * server about which column to search.
         *
         * `true` for canViewSensitive is not a claim of access — the phone
         * probe only exists in `runnable` when planApsiLookup confirmed BOTH
         * customers.read and customers.view_sensitive hold, and the name probe
         * never sends a phone-shaped query (the classifier routed those to the
         * phone probe). The server re-derives the grant from the membership
         * regardless and would refuse.
         *
         * Every match is returned as its own card. Apsi never picks one of
         * several customers who share a name — choosing for the merchant is
         * how the wrong person gets told about someone else's order.
         */
        const page = await searchRealCustomers(probe.value, true, {
          limit: APSI_CUSTOMER_RESULT_LIMIT,
        });
        return {
          ok: true,
          incomplete: page.hasMore || page.truncated,
          results: page.customers.map((customer) => ({
            kind: "customer" as const,
            id: customer.id,
            name: customer.nameKm || customer.nameEn,
            phone: customer.phone,
            sensitiveVisible: customer.sensitiveVisible !== false,
            // A finder read carries no order history. null, never 0.
            orderCount: null,
            lastPurchaseAt: null,
          })),
        };
      }

      case "product-by-barcode":
      case "product-by-sku": {
        const product =
          probe.kind === "product-by-barcode"
            ? await lookupProductByBarcode(probe.value)
            : await lookupProductBySku(probe.value);
        if (!product) return { ok: true, results: [] };
        return {
          ok: true,
          results: [await withStock(product, grants)],
        };
      }

      case "delivery-search": {
        const page = await listRealDeliveries({
          search: probe.value,
          limit: APSI_DELIVERY_RESULT_LIMIT,
        });
        return {
          ok: true,
          // The Delivery domain already reports both of these honestly; Apsi
          // passes them through rather than presenting a page as the whole set.
          incomplete: page.hasMore || page.truncated,
          results: page.items.map((item) => ({
            kind: "delivery" as const,
            id: item.id,
            orderId: item.orderId,
            orderCode: item.orderCode,
            status: item.status,
            providerName: item.providerName,
            trackingNumber: item.externalTrackingNumber,
            customerName: item.customerName,
          })),
        };
      }
    }
  } catch {
    /*
     * Deliberately not inspected further. Whatever went wrong — a 403 the
     * capability snapshot did not predict, a network failure, a 404 — the
     * honest report is the same: this probe did not answer. It is surfaced as
     * a failure, not folded into an empty result set.
     */
    return { ok: false };
  }
}

/**
 * Attach the Inventory-domain stock balance to a catalogue hit, when the
 * member may read it. A failure leaves `stock` null: "we could not check"
 * reads correctly, "0 in stock" would not.
 */
async function withStock(
  product: Awaited<ReturnType<typeof lookupProductBySku>> & object,
  grants: ApsiGrants,
): Promise<ApsiProductResult> {
  const base: ApsiProductResult = {
    kind: "product",
    id: product.id,
    variantId: product.variantId ?? null,
    name: product.nameKm || product.nameEn,
    sku: product.sku,
    barcode: product.barcode ?? null,
    price: product.price,
    stock: product.stock,
  };

  if (base.stock !== null || !base.variantId || !grants.can("inventory.read")) return base;

  try {
    const stock = await getVariantStock(base.variantId);
    return { ...base, stock: stock.quantityOnHand };
  } catch {
    return base;
  }
}

/**
 * Run every probe this member may run, in parallel, and collect the answers.
 *
 * Deduplicated by domain + id, because a barcode and a SKU probe can legally
 * resolve to the same product and one hit should read as one result.
 */
export async function runApsiLookup(
  plan: ApsiQueryPlan,
  grants: ApsiGrants,
): Promise<ApsiLookupOutcome> {
  const { runnable, skipped } = planApsiLookup(plan, grants);

  if (runnable.length === 0) {
    return { results: [], skipped, failed: [], answered: false, incomplete: false };
  }

  const outcomes = await Promise.all(runnable.map((probe) => runProbe(probe, grants)));

  const results: ApsiResult[] = [];
  const failed: ApsiFailedProbe[] = [];
  const seen = new Set<string>();
  let answered = false;
  let incomplete = false;

  outcomes.forEach((outcome, index) => {
    const probe = runnable[index]!;
    if (!outcome.ok) {
      failed.push({ kind: probe.kind });
      return;
    }
    answered = true;
    if (outcome.incomplete) incomplete = true;
    for (const result of outcome.results) {
      const identity = `${result.kind}:${result.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      results.push(result);
    }
  });

  return { results, skipped, failed, answered, incomplete };
}

/** Where a result card's primary action goes. The domain owns the workflow. */
export function apsiResultRoute(result: ApsiResult): {
  to:
    | "/app/orders/$id"
    | "/app/payments/$id"
    | "/app/deliveries/$id"
    | "/app/customers/$id"
    | "/app/products/$id";
  id: string;
} {
  switch (result.kind) {
    case "order":
      return { to: "/app/orders/$id", id: result.id };
    case "payment":
      return { to: "/app/payments/$id", id: result.id };
    case "delivery":
      return { to: "/app/deliveries/$id", id: result.id };
    case "customer":
      return { to: "/app/customers/$id", id: result.id };
    case "product":
      return { to: "/app/products/$id", id: result.id };
  }
}
