/**
 * APSA rule: every state-changing server function uses an explicit non-GET
 * method (POST). GET is read-only.
 *
 * Root cause this guards against: TanStack Start 1.168 defaults an omitted
 * `createServerFn()` method to GET (start-client-core/createServerFn.js), and a
 * GET call carries its whole payload in the `?payload=` query string
 * (start-client-core/client-rpc/serverFnFetcher.js). Before this guard, 58
 * mutations — including sign-in/sign-up passwords, OTPs, recovery tokens,
 * order/delivery/handoff/payment/refund mutations — were GET.
 *
 * How the guard works (structural, not a name list of mutations):
 *   1. Every createServerFn in src/ (tests excluded) is discovered from the
 *      TypeScript AST (helpers/server-fn-inventory.ts), with its declared
 *      method read from the real call argument.
 *   2. A function may be GET only if it is registered in READ_ONLY_SERVER_FNS
 *      below with a reason. EVERY other server function must declare
 *      `{ method: "POST" }` explicitly. So a new server function that forgets
 *      the method fails here until someone either makes it POST or consciously
 *      registers it as a read.
 *   3. A registered read must look like one: a read-verb name, and no
 *      write-verb call anywhere in its handler body (beyond the reviewed
 *      session-maintenance calls listed on its entry).
 *   4. The registry cannot go stale: every entry must still exist as GET.
 */
import { describe, expect, it } from "bun:test";
import { inventoryServerFns, type ServerFnDefinition } from "./helpers/server-fn-inventory";

interface ReadOnlyEntry {
  reason: string;
  /**
   * Write-verb calls the handler is allowed to make because they maintain the
   * caller's OWN session cookies (token refresh / clearing an expired or
   * revoked session) — never domain data. Reviewed individually.
   */
  sessionMaintenance?: string[];
}

/**
 * The ONLY server functions allowed to use GET. Adding an entry is a security
 * review decision: the function must not change any domain state.
 */
export const READ_ONLY_SERVER_FNS: Record<string, ReadOnlyEntry> = {
  // auth / session
  getSessionFn: {
    reason: "reads the cookie session; refreshes the caller's own expired access token",
  },
  checkAppGuardFn: {
    reason: "route guard read; clears the caller's cookies when membership is revoked",
    sessionMaintenance: ["clearAuthCookieFn"],
  },
  getAccountProfileFn: { reason: "reads the caller's profile" },
  getPasswordRecoveryStatusFn: {
    reason: "reads recovery state; drops the caller's own expired recovery cookies",
    sessionMaintenance: ["clearRecoveryCookies"],
  },
  getPendingVerificationFn: { reason: "reads the caller's unverified email" },
  getActiveMemberCapabilitiesFn: { reason: "reads the caller's capabilities" },
  getInvitationPreviewFn: { reason: "previews an invitation; acceptance is POST" },
  // analytics / home
  getBusinessSummaryFn: { reason: "analytics read" },
  getTopSellingItemsFn: { reason: "analytics read" },
  getCustomerSummaryFn: { reason: "analytics read" },
  getHomeSummaryFn: { reason: "home dashboard read" },
  // conversations / customers
  listConversationsFn: { reason: "list read" },
  listConversationCountsFn: { reason: "count read" },
  getConversationDetailFn: { reason: "detail read" },
  listConversationMessagesFn: { reason: "list read" },
  findCustomerConversationFn: { reason: "lookup read" },
  getCustomer360Fn: { reason: "detail read" },
  listCustomersFn: { reason: "list read" },
  searchCustomersFn: { reason: "search read" },
  // orders / payments
  getOrderByIdFn: { reason: "detail read" },
  findOrderByCodeFn: { reason: "lookup read" },
  listOrdersFn: { reason: "list read" },
  getPaymentByIdFn: { reason: "detail read" },
  listPaymentsFn: { reason: "list read" },
  getPaymentReconciliationFn: { reason: "summary read" },
  getOrderSettlementFn: { reason: "settlement read" },
  // fulfillment / packing / parcels / deliveries / handoff
  listReadyToPackFn: { reason: "queue read" },
  getParcelLabelDataFn: { reason: "label data read; never creates a parcel (CORRECTION-003)" },
  getInternalParcelLabelDataFn: { reason: "label data read; never creates a parcel" },
  getPackRequirementsFn: { reason: "pack checklist read" },
  validatePackParcelScanFn: { reason: "scan comparison; writes nothing" },
  validatePackProductScanFn: { reason: "scan comparison; writes nothing" },
  getOrderPackStateFn: { reason: "pack state read" },
  resolveParcelIdentityFn: { reason: "parcel lookup read" },
  resolveParcelCodeFn: { reason: "parcel lookup read" },
  getDeliveryByIdFn: { reason: "detail read" },
  listDeliveriesFn: { reason: "list read" },
  listDeliveriesForMerchantFn: { reason: "list read" },
  getHandoffPreviewFn: { reason: "handoff preview; confirmation is POST" },
  // inventory / products / receiving / stock count / scan
  getVariantStockFn: { reason: "ledger sum read" },
  listMovementHistoryFn: { reason: "ledger read" },
  listOrganizationStockFn: { reason: "ledger sum read" },
  listInventoryLocationsFn: { reason: "list read" },
  listProductsFn: { reason: "catalog read" },
  getProductDetailFn: { reason: "detail read" },
  lookupBySkuFn: { reason: "lookup read" },
  lookupByBarcodeFn: { reason: "lookup read" },
  listCategoriesFn: { reason: "list read" },
  resolveReceivingScanFn: { reason: "scan lookup read" },
  resolveStockCountScanFn: { reason: "scan lookup read" },
  searchStockCountProductsFn: { reason: "search read" },
  getStockCountItemFn: { reason: "detail read" },
  previewStockCountFn: { reason: "computes a preview; recording is POST" },
  resolveScanFn: { reason: "scan lookup read" },
  // returns / org / team
  listCustomerReturnsFn: { reason: "list read" },
  getCustomerReturnFn: { reason: "detail read" },
  findReturnableOrderFn: { reason: "lookup read" },
  findReturnableOrderByParcelFn: { reason: "lookup read" },
  getOrganizationProfileFn: { reason: "profile read" },
  listTeamFn: { reason: "list read" },
};

const READ_NAME = /^(get|list|find|lookup|search|resolve|preview|validate|check)[A-Z]/;

/** A call whose name says it writes. Read handlers must not make one. */
const WRITE_CALL =
  /^(create|update|upsert|insert|delete|remove|record|mark|transition|confirm|cancel|refund|reverse|verify|correct|attach|archive|generate|receive|inspect|complete|request|invite|resend|change|deactivate|reactivate|accept|assign|recover|retry|sign|clear|write|set|add|pack|ingest)(?:[A-Z]|$)/;

/** Client factories, not writes. */
const NON_WRITE_FACTORIES = new Set(["createAnonAuthClient", "createServerClient", "createClient"]);

const inventory = inventoryServerFns();
const byName = new Map(inventory.definitions.map((d) => [d.name, d]));
const describeFn = (d: ServerFnDefinition) => `${d.name} (${d.file}:${d.line}, method=${d.method})`;

describe("server-function inventory", () => {
  it("discovers the server functions (sanity floor)", () => {
    expect(inventory.definitions.length).toBeGreaterThanOrEqual(124);
  });

  it("every createServerFn is an exported const (nothing hides from the inventory)", () => {
    expect(inventory.unboundCalls).toEqual([]);
  });

  it("server function names are unique", () => {
    expect(byName.size).toBe(inventory.definitions.length);
  });

  it("no server function computes its method at runtime", () => {
    const dynamic = inventory.definitions.filter((d) => d.method === "non-literal");
    expect(dynamic.map(describeFn)).toEqual([]);
  });
});

describe("APSA rule: mutations are POST, GET is read-only", () => {
  it('every server function not registered as a read declares method: "POST" explicitly', () => {
    const offenders = inventory.definitions.filter(
      (d) => !(d.name in READ_ONLY_SERVER_FNS) && d.method !== "POST",
    );
    expect(
      offenders.map(describeFn),
      'State-changing server functions must use createServerFn({ method: "POST" }). ' +
        "If this function is genuinely read-only, register it in READ_ONLY_SERVER_FNS with a reason.",
    ).toEqual([]);
  });

  it("every registered read still exists and is GET (registry cannot go stale)", () => {
    const stale = Object.keys(READ_ONLY_SERVER_FNS).filter(
      (name) => byName.get(name)?.effectiveMethod !== "GET",
    );
    expect(stale).toEqual([]);
  });

  it("registered reads have read-verb names", () => {
    const misnamed = Object.keys(READ_ONLY_SERVER_FNS).filter((name) => !READ_NAME.test(name));
    expect(misnamed).toEqual([]);
  });

  it("registered read handlers make no write-verb call beyond reviewed session maintenance", () => {
    const violations: string[] = [];
    for (const [name, entry] of Object.entries(READ_ONLY_SERVER_FNS)) {
      const def = byName.get(name);
      if (!def) continue;
      const allowed = new Set(entry.sessionMaintenance ?? []);
      for (const callee of def.handlerCallees) {
        if (NON_WRITE_FACTORIES.has(callee) || allowed.has(callee)) continue;
        if (WRITE_CALL.test(callee) && !READ_NAME.test(callee))
          violations.push(`${name} → ${callee}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the staging findings and every high-risk mutation are POST", () => {
    const mustBePost = [
      // staging E2E findings
      "createOrderFn",
      "createDeliveryFn",
      "startPreparingDeliveryFn",
      "markDeliveryReadyFn",
      "markDeliveryInTransitFn",
      "markDeliveryDeliveredFn",
      "markDeliveryFailedFn",
      "cancelDeliveryFn",
      "confirmHandoffFn",
      "recoverOrderParcelFn",
      "markOrderPackedFn",
      // order / payment / refund
      "transitionOrderLifecycleFn",
      "transitionOrderPaymentFn",
      "transitionOrderFulfillmentFn",
      "updateOrderShippingFn",
      "recordPaymentFn",
      "verifyPaymentFn",
      "reversePaymentFn",
      "refundPaymentFn",
      "correctPaymentFn",
      "attachPaymentEvidenceFn",
      // returns / inventory
      "requestCustomerReturnFn",
      "receiveCustomerReturnFn",
      "inspectCustomerReturnFn",
      "completeCustomerReturnFn",
      "recordMovementFn",
      "receiveInventoryFn",
      "recordStockCountFn",
      // auth secrets
      "signInFn",
      "signUpFn",
      "verifyEmailFn",
      "beginPasswordRecoveryFn",
      "completePasswordRecoveryFn",
      "acceptInvitationFn",
    ];
    const notPost = mustBePost.filter((name) => byName.get(name)?.method !== "POST");
    expect(notPost).toEqual([]);
  });
});
