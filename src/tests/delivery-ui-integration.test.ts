/**
 * Delivery UI Production Integration — structural assertions.
 *
 * The pure logic behind this phase (mapping, transition-visibility rules,
 * error classification) is unit-tested directly in src/tests/deliveries-ui.test.ts.
 * What remains — which server function a route/component calls, what a
 * payload object does and does not contain, whether a mutation refreshes the
 * cache on success — is proven here by reading the actual source text, the
 * same approach as src/tests/order-ui-integration.test.ts.
 *
 * Bundle-boundary (routes/api never statically import server-only modules)
 * is already covered generically for every file under src/routes and src/api
 * by src/tests/bundle-boundary.test.ts — it walks the directories, so the new
 * files in this phase are covered without any change there.
 *
 * Run: bun test src/tests/delivery-ui-integration.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

const API_INDEX = "src/lib/api/index.ts";
const DELIVERIES_LIB = "src/lib/deliveries.ts";
const DELIVERY_DETAIL_ROUTE = "src/routes/app.deliveries.$id.tsx";
const ORDER_DETAIL_ROUTE = "src/routes/app.orders.$id.tsx";
const CREATE_DELIVERY_SHEET = "src/components/delivery/CreateDeliverySheet.tsx";
const REASON_SHEET = "src/components/delivery/DeliveryReasonSheet.tsx";
const DELIVERIES_API = "src/api/deliveries.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. DELIVERY DETAIL uses the production API for real UUIDs, mock path untouched
// ═══════════════════════════════════════════════════════════════════════════════

describe("Delivery detail branches on isProductionId — real deliveries never fall back to mock", () => {
  it("the route calls getRealDeliveryDetail for the production branch and getDeliveryDetail for the mock branch", () => {
    const route = readSource(DELIVERY_DETAIL_ROUTE);
    expect(route).toMatch(/isProductionId\(id\)\s*\?\s*\(?\s*<RealDeliveryDetailScreen/);
    expect(route).toMatch(/getRealDeliveryDetail\(id\)/);
    expect(route).toMatch(/getDeliveryDetail\(id\)/); // the untouched mock path
  });

  it("getRealDeliveryDetail has no try/catch demo-mode fallback — a real UUID lookup failure is never hidden behind mock data", () => {
    const apiIndex = readSource(API_INDEX);
    const fn = apiIndex.slice(
      apiIndex.indexOf("export async function getRealDeliveryDetail"),
      apiIndex.indexOf("export async function listRealDeliveriesForOrder"),
    );
    expect(fn).toMatch(/getDeliveryByIdFn/);
    expect(fn).not.toMatch(/try\s*{/);
    expect(fn).not.toMatch(/catch/);
    expect(fn).not.toMatch(/isDemoModeError/);
  });

  it("the mock delivery detail screen (MockDeliveryDetailScreen) is unmodified in structure — still keyed off getDeliveryDetail/PERMISSION_DENIED/applyDeliveryAction", () => {
    const route = readSource(DELIVERY_DETAIL_ROUTE);
    const mockScreen = route.slice(route.indexOf("function MockDeliveryDetailScreen"));
    expect(mockScreen).toMatch(/getDeliveryDetail\(id\)/);
    expect(mockScreen).toMatch(/PERMISSION_DENIED/);
    expect(mockScreen).toMatch(/applyDeliveryAction/);
    expect(mockScreen).toMatch(/DeliveryProgress/);
  });

  it("the real screen does not render the mock-only DeliveryProgress stepper (a different status vocabulary)", () => {
    const route = readSource(DELIVERY_DETAIL_ROUTE);
    const realScreen = route.slice(
      route.indexOf("function RealDeliveryDetailScreen"),
      route.indexOf("function MockDeliveryDetailScreen"),
    );
    expect(realScreen).not.toMatch(/<DeliveryProgress/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. SECURITY: no organization_id / user_id from the client, no direct Supabase
// ═══════════════════════════════════════════════════════════════════════════════

describe("Security boundary: client never supplies organization_id/user_id", () => {
  it("CreateRealDeliveryInput and createRealDelivery's payload have no organizationId/userId/organization_id/user_id field", () => {
    const apiIndex = readSource(API_INDEX);
    const block = apiIndex.slice(
      apiIndex.indexOf("export interface CreateRealDeliveryInput"),
      apiIndex.indexOf("export async function startPreparingRealDelivery"),
    );
    for (const forbidden of ["organizationId", "organization_id", "userId", "user_id"]) {
      expect(block).not.toContain(forbidden);
    }
  });

  it("the create-delivery sheet never constructs a payload with organizationId/userId", () => {
    const sheet = readSource(CREATE_DELIVERY_SHEET);
    const submitFn = sheet.slice(sheet.indexOf("async function submit()"), sheet.indexOf("const failureCopy"));
    for (const forbidden of ["organizationId", "organization_id", "userId", "user_id"]) {
      expect(submitFn).not.toContain(forbidden);
    }
  });

  it("no file in this phase has a static import of src/lib/supabase/server or src/server/deliveries/repository (comments referencing them are fine)", () => {
    for (const file of [
      API_INDEX,
      DELIVERIES_LIB,
      DELIVERY_DETAIL_ROUTE,
      ORDER_DETAIL_ROUTE,
      CREATE_DELIVERY_SHEET,
      REASON_SHEET,
    ]) {
      const importLines = readSource(file)
        .split("\n")
        .filter((line) => /^\s*import\s/.test(line));
      for (const line of importLines) {
        expect(line).not.toMatch(/lib\/supabase\/server/);
        expect(line).not.toMatch(/server\/deliveries\/repository/);
      }
    }
  });

  it("UUID validation is not weakened — src/api/deliveries.ts still validates every id with z.string().uuid()", () => {
    const src = readSource(DELIVERIES_API);
    expect(src).toMatch(/deliveryId:\s*z\.string\(\)\.uuid\(/);
    expect(src).toMatch(/orderId:\s*z\.string\(\)\.uuid\(/);
  });

  it("isProductionId (the mock/UUID boundary) is unchanged in shape — non-UUID mock ids never reach the server validator", () => {
    const apiIndex = readSource(API_INDEX);
    const fn = apiIndex.slice(
      apiIndex.indexOf("export function isProductionId"),
      apiIndex.indexOf("export interface ConversationFilter"),
    );
    expect(fn).toMatch(/\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CREATE FLOW calls createDeliveryFn only
// ═══════════════════════════════════════════════════════════════════════════════

describe("Create flow calls createDeliveryFn, never recreates Delivery business logic client-side", () => {
  it("createRealDelivery (lib/api) calls createDeliveryFn", () => {
    const apiIndex = readSource(API_INDEX);
    const fn = apiIndex.slice(
      apiIndex.indexOf("export async function createRealDelivery"),
      apiIndex.indexOf("export async function startPreparingRealDelivery"),
    );
    expect(fn).toMatch(/await import\(["']@\/api\/deliveries["']\)/);
    expect(fn).toMatch(/createDeliveryFn/);
  });

  it("the create sheet supports the manual-provider path and does not invent a providerId picker/new provider architecture", () => {
    const sheet = readSource(CREATE_DELIVERY_SHEET);
    expect(sheet).toMatch(/providerName/);
    expect(sheet).not.toMatch(/listProvidersFn|delivery_providers/);
  });

  it("a delivery is only offered on an eligible confirmed order — gated by canCreateDeliveryForOrder from src/lib/deliveries.ts", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    expect(route).toMatch(/canCreateDeliveryForOrder\(\{/);
    expect(route).toMatch(/lifecycleStatus:\s*order\.lifecycleStatus/);
    expect(route).toMatch(/fulfillmentStatus:\s*order\.fulfillmentStatus/);
  });

  it("an existing active delivery blocks the create/replacement button (checked via isActiveDeliveryStatus)", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    expect(route).toMatch(/isActiveDeliveryStatus/);
    expect(route).toMatch(/!activeDelivery/);
  });

  it("after cancellation (no active delivery, order still eligible) the button offers a replacement, not a fresh 'arrange'", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    expect(route).toMatch(/isReplacementDelivery/);
    expect(route).toMatch(/createReplacementDelivery/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. TRANSITIONS: valid transitions call the matching server fn; UI gating is a hint only
// ═══════════════════════════════════════════════════════════════════════════════

describe("Delivery transitions call the matching production server function", () => {
  const TRANSITIONS: Array<[fn: string, serverFn: string]> = [
    ["startPreparingRealDelivery", "startPreparingDeliveryFn"],
    ["markRealDeliveryReady", "markDeliveryReadyFn"],
    ["markRealDeliveryInTransit", "markDeliveryInTransitFn"],
    ["markRealDeliveryDelivered", "markDeliveryDeliveredFn"],
    ["markRealDeliveryFailed", "markDeliveryFailedFn"],
    ["cancelRealDelivery", "cancelDeliveryFn"],
  ];

  for (const [fn, serverFn] of TRANSITIONS) {
    it(`${fn} calls ${serverFn} and nothing else`, () => {
      const apiIndex = readSource(API_INDEX);
      const start = apiIndex.indexOf(`export async function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const body = apiIndex.slice(start, apiIndex.indexOf("\n}\n", start) + 3);
      expect(body).toMatch(new RegExp(serverFn));
    });
  }

  it("the real screen shows exactly the buttons the client-side state machine allows for the current status", () => {
    const route = readSource(DELIVERY_DETAIL_ROUTE);
    expect(route).toMatch(/canStartPreparingDelivery\(d\.status\)/);
    expect(route).toMatch(/canMarkDeliveryReady\(d\.status\)/);
    expect(route).toMatch(/canMarkDeliveryInTransit\(d\.status\)/);
    expect(route).toMatch(/canMarkDeliveryDelivered\(d\.status\)/);
    expect(route).toMatch(/canMarkDeliveryFailed\(d\.status\)/);
    expect(route).toMatch(/canCancelDelivery\(d\.status\)/);
  });

  it("client-side gating is documented as a hint only, never authorization, in src/lib/deliveries.ts", () => {
    const lib = readSource(DELIVERIES_LIB);
    expect(lib).toMatch(/never a substitute for server authorization/i);
  });

  it("a stale (409, changed concurrently) transition error triggers a refetch of authoritative data", () => {
    const route = readSource(DELIVERY_DETAIL_ROUTE);
    expect(route).toMatch(/classifyDeliveryError\(error\) === "stale"/);
    expect(route).toMatch(/query\.refetch\(\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CANCELLATION / REPLACEMENT
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cancellation drives order fulfillment via the server only, never resets it from the UI", () => {
  it("cancelRealDelivery/markRealDeliveryFailed require a non-empty reason, matching src/api/deliveries.ts's reasonRequiredSchema", () => {
    const sheet = readSource(REASON_SHEET);
    expect(sheet).toMatch(/reason\.trim\(\)/);
    expect(sheet).toMatch(/trimmed\.length === 0/);
  });

  it("the UI never writes to order fulfillment/lifecycle directly — no order-table mutation appears in the delivery route or sheets", () => {
    for (const file of [DELIVERY_DETAIL_ROUTE, CREATE_DELIVERY_SHEET, REASON_SHEET, API_INDEX]) {
      const src = readSource(file);
      expect(src).not.toMatch(/from\(["']orders["']\)/);
      expect(src).not.toMatch(/\.update\(\s*\{\s*fulfillment_status/);
    }
  });

  it("cancelling invalidates the linked order's query so the authoritative unfulfilled state is re-read", () => {
    const route = readSource(DELIVERY_DETAIL_ROUTE);
    expect(route).toMatch(/invalidateQueries\(\{ queryKey: \["order", "real", detail\?\.orderId\] \}\)/);
  });

  it("the Order screen lists deliveries by order id so a cancelled+replaced delivery both stay visible in history", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    expect(route).toMatch(/listRealDeliveriesForOrder/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. COD — delivery success never marks the order as paid
// ═══════════════════════════════════════════════════════════════════════════════

describe("COD regression: delivery creation/completion never touches order payment", () => {
  it("markRealDeliveryDelivered's payload has no payment/paid field and calls only markDeliveryDeliveredFn", () => {
    const apiIndex = readSource(API_INDEX);
    const start = apiIndex.indexOf("export async function markRealDeliveryDelivered(");
    const body = apiIndex.slice(start, apiIndex.indexOf("\n}\n", start) + 3);
    expect(body).toMatch(/markDeliveryDeliveredFn/);
    expect(body).not.toMatch(/paid|payment/i);
  });

  it("createRealDelivery's payload never sets a payment status, even when codAmountMinor is present", () => {
    const apiIndex = readSource(API_INDEX);
    const start = apiIndex.indexOf("export async function createRealDelivery(");
    const body = apiIndex.slice(start, apiIndex.indexOf("\n}\n", start) + 3);
    expect(body).toMatch(/codAmountMinor/);
    expect(body).not.toMatch(/paymentStatus|payment_status|"paid"/i);
  });

  it("the production Delivery service layer never writes to order payment fields (src/server/deliveries/service.ts)", () => {
    const service = readSource("src/server/deliveries/service.ts");
    expect(service).not.toMatch(/payment_status|paymentStatus/);
  });

  it("the real detail screen's COD section documents that it is operational-only, never a paid signal", () => {
    const route = readSource(DELIVERY_DETAIL_ROUTE);
    expect(route).toMatch(/delivery\.create\.codHint/);
  });

  it("the create-delivery sheet's own comment states COD is operational only", () => {
    const sheet = readSource(CREATE_DELIVERY_SHEET);
    expect(sheet).toMatch(/operational only/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. ERROR STATES — unauthorized / forbidden / not found / invalid / stale / server
// ═══════════════════════════════════════════════════════════════════════════════

describe("Error states are classified and mapped to translated copy, never raw error text", () => {
  it("the real detail screen redirects to /sign-in on 'unauthorized' rather than rendering inline copy", () => {
    const route = readSource(DELIVERY_DETAIL_ROUTE);
    expect(route).toMatch(/classifyDeliveryError\(query\.error\) === "unauthorized"/);
    expect(route).toMatch(/navigate\(\{ to: "\/sign-in" \}\)/);
  });

  it("forbidden / not_found / stale / invalid each resolve to a distinct translated title+body pair", () => {
    const route = readSource(DELIVERY_DETAIL_ROUTE);
    const copyFn = route.slice(
      route.indexOf("function useDeliveryErrorCopy"),
      route.indexOf("const HISTORY_TONE"),
    );
    expect(copyFn).toMatch(/case "forbidden":/);
    expect(copyFn).toMatch(/case "not_found":/);
    expect(copyFn).toMatch(/case "stale":/);
    expect(copyFn).toMatch(/case "invalid":/);
    expect(copyFn).not.toMatch(/err\.message|error\.message/);
  });

  it("no route or sheet in this phase interpolates a raw caught error's message into JSX", () => {
    for (const file of [DELIVERY_DETAIL_ROUTE, CREATE_DELIVERY_SHEET]) {
      const src = readSource(file);
      expect(src).not.toMatch(/\{error\.message\}|\{err\.message\}/);
    }
  });

  it("non-UUID/mock ids never reach the production server functions — isProductionId gates the branch", () => {
    const route = readSource(DELIVERY_DETAIL_ROUTE);
    expect(route).toMatch(/isProductionId\(id\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. LOADING / EMPTY UX
// ═══════════════════════════════════════════════════════════════════════════════

describe("Loading states use the existing APSA visual system", () => {
  it("the real detail screen renders ListSkeleton while loading", () => {
    expect(readSource(DELIVERY_DETAIL_ROUTE)).toMatch(/query\.isLoading[\s\S]{0,200}ListSkeleton/);
  });

  it("Delivery screens use the Apsi-free OperationalState, never the Apsi-carrying EmptyState/ErrorState", () => {
    for (const file of [DELIVERY_DETAIL_ROUTE, CREATE_DELIVERY_SHEET]) {
      const src = readSource(file);
      expect(src).not.toMatch(/\bEmptyState\b/);
      expect(src).not.toMatch(/\bErrorState\b/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Successful transitions refresh the on-screen delivery
// ═══════════════════════════════════════════════════════════════════════════════

describe("Successful transitions refresh the on-screen delivery", () => {
  it("all six transition mutations write the fresh detail into the query cache via onTransitionSuccess", () => {
    const route = readSource(DELIVERY_DETAIL_ROUTE);
    expect(route).toMatch(/queryClient\.setQueryData\(queryKey, detail\)/);
    for (const mutationVar of [
      "startPreparingMutation",
      "markReadyMutation",
      "markInTransitMutation",
      "markDeliveredMutation",
      "markFailedMutation",
      "cancelMutation",
    ]) {
      expect(route).toMatch(new RegExp(`const ${mutationVar} = useMutation`));
    }
  });

  it("creating a delivery from the order screen invalidates that order's deliveries query", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    expect(route).toMatch(/invalidateQueries\(\{ queryKey: deliveriesQueryKey \}\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Scope discipline — this phase does not touch Payment/Conversation/POS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scope discipline: no Payment-domain, Conversation, or POS code touched", () => {
  it("no new file in this phase imports a Payment-domain module", () => {
    for (const file of [
      API_INDEX,
      DELIVERIES_LIB,
      DELIVERY_DETAIL_ROUTE,
      ORDER_DETAIL_ROUTE,
      CREATE_DELIVERY_SHEET,
      REASON_SHEET,
    ]) {
      const src = readSource(file);
      expect(src).not.toMatch(/@\/server\/payments|@\/api\/payments/);
    }
  });

  it("no new file imports conversation or POS modules", () => {
    for (const file of [DELIVERIES_LIB, DELIVERY_DETAIL_ROUTE, CREATE_DELIVERY_SHEET, REASON_SHEET]) {
      const src = readSource(file);
      expect(src).not.toMatch(/@\/lib\/mock\/conversations|@\/server\/pos/);
    }
  });
});
