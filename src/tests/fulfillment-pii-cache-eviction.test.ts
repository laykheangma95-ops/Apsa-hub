/**
 * Raw parcel-label PII (customer name, phone, delivery address) must LEAVE the
 * React Query cache when `fulfillment.print_label` is revoked — not merely be
 * hidden by the dialog. Every assertion inspects the QueryClient directly, so a
 * fix that only gated the dialog would leave the raw values in the cache and
 * fail these tests. This is the Fulfillment-domain counterpart of
 * customer-pii-cache-eviction.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FulfillmentSensitiveCacheGuard } from "@/components/fulfillment/FulfillmentSensitiveCacheGuard";
import { CapabilityFixtureProvider } from "@/hooks/use-capabilities";
import type { UiPermissionKey } from "@/lib/capabilities";
import {
  clearFulfillmentQueries,
  fulfillmentKeys,
  enforceFulfillmentCachePrincipal,
  enforceFulfillmentSensitiveCache,
} from "@/lib/fulfillment-query";
import { readFileSync } from "node:fs";

const USER = "user-1";
const ORG = "org-1";
const OTHER_USER = "user-2";
const OTHER_ORG = "org-2";
const ORDER_ID = "12345678-90ab-4cde-8f01-234567890abc";

const RAW_NAME = "Sokha Chan";
const RAW_PHONE = "+855 12 345 678";
const RAW_ADDRESS = "Street 271, Toul Tompoung, Phnom Penh";
const RAW_VALUES = [RAW_NAME, RAW_PHONE, RAW_ADDRESS];

/** A parcel-label payload as the dialog's Promise.all(getParcelLabelData) caches it. */
const labelPayload = [
  {
    merchant: { businessName: "Dara Shop" },
    customer: { name: RAW_NAME, phone: RAW_PHONE, address: RAW_ADDRESS, addressConfirmed: false },
    order: {
      id: ORDER_ID,
      orderNumber: "APSA-2026-001048",
      currency: "KHR",
      itemCount: 1,
      items: [],
    },
    reprint: false,
    payment: { paid: false, collect: { amount: 70000, currency: "KHR" } },
    delivery: null,
  },
];

function seedGrantEraCache(queryClient: QueryClient, userId = USER, organizationId = ORG) {
  queryClient.setQueryData(
    fulfillmentKeys.parcelLabels(userId, organizationId, [ORDER_ID]),
    labelPayload,
  );
}

function cacheDump(queryClient: QueryClient): string {
  return JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => ({ key: query.queryKey, data: query.state.data })),
  );
}

function expectNoRawPii(queryClient: QueryClient) {
  const dump = cacheDump(queryClient);
  for (const value of RAW_VALUES) expect(dump).not.toContain(value);
}

describe("enforceFulfillmentSensitiveCache — raw parcel PII leaves the cache on revocation", () => {
  it("granted -> revoked removes the parcel-label entry holding name/phone/address", () => {
    const queryClient = new QueryClient();
    enforceFulfillmentSensitiveCache(queryClient, USER, ORG, true);
    seedGrantEraCache(queryClient);
    for (const value of RAW_VALUES) expect(cacheDump(queryClient)).toContain(value);

    // Still granted: nothing is touched.
    enforceFulfillmentSensitiveCache(queryClient, USER, ORG, true);
    expect(queryClient.getQueryData(fulfillmentKeys.parcelLabels(USER, ORG, [ORDER_ID]))).toEqual(
      labelPayload,
    );

    // Revoked.
    enforceFulfillmentSensitiveCache(queryClient, USER, ORG, false);
    expectNoRawPii(queryClient);
    expect(
      queryClient.getQueryData(fulfillmentKeys.parcelLabels(USER, ORG, [ORDER_ID])),
    ).toBeUndefined();
  });

  it("a first observation of 'not allowed' also evicts (fail-closed on a failed refresh)", () => {
    const queryClient = new QueryClient();
    seedGrantEraCache(queryClient);
    enforceFulfillmentSensitiveCache(queryClient, USER, ORG, false);
    expectNoRawPii(queryClient);
  });

  it("cancels + removes an in-flight parcel-label fetch so a late response cannot rewrite PII", async () => {
    const queryClient = new QueryClient();
    enforceFulfillmentSensitiveCache(queryClient, USER, ORG, true);
    // A fetch that would resolve with raw PII after the revoke.
    let resolveFetch: (v: unknown) => void = () => {};
    const pending = queryClient.fetchQuery({
      queryKey: fulfillmentKeys.parcelLabels(USER, ORG, [ORDER_ID]),
      queryFn: () => new Promise((r) => (resolveFetch = r)),
    });
    // Revoke while it is in flight: cancelQueries + removeQueries.
    enforceFulfillmentSensitiveCache(queryClient, USER, ORG, false);
    // Let the late response arrive — it must not repopulate the cache.
    resolveFetch(labelPayload);
    await pending.catch(() => undefined);
    expectNoRawPii(queryClient);
    expect(
      queryClient.getQueryData(fulfillmentKeys.parcelLabels(USER, ORG, [ORDER_ID])),
    ).toBeUndefined();
  });

  it("is principal-scoped: another member's partition is not this call's to touch", () => {
    const queryClient = new QueryClient();
    enforceFulfillmentSensitiveCache(queryClient, USER, ORG, true);
    enforceFulfillmentSensitiveCache(queryClient, OTHER_USER, ORG, true);
    seedGrantEraCache(queryClient, OTHER_USER, ORG);
    enforceFulfillmentSensitiveCache(queryClient, USER, ORG, false);
    expect(
      queryClient.getQueryData(fulfillmentKeys.parcelLabels(OTHER_USER, ORG, [ORDER_ID])),
    ).toEqual(labelPayload);
  });
});

describe("FulfillmentSensitiveCacheGuard — the /app wiring evicts during render", () => {
  function renderGuard(queryClient: QueryClient, permissions: readonly UiPermissionKey[]) {
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          CapabilityFixtureProvider,
          { permissions },
          createElement(
            FulfillmentSensitiveCacheGuard,
            { userId: USER, organizationId: ORG },
            null,
          ),
        ),
      ),
    );
  }

  it("losing fulfillment.print_label removes raw parcel PII from the QueryClient", () => {
    const queryClient = new QueryClient();
    renderGuard(queryClient, ["orders.read", "fulfillment.print_label"]);
    seedGrantEraCache(queryClient);
    renderGuard(queryClient, ["orders.read", "fulfillment.print_label"]);
    expect(cacheDump(queryClient)).toContain(RAW_PHONE);

    renderGuard(queryClient, ["orders.read"]);
    expectNoRawPii(queryClient);
  });

  it("is mounted in the /app layout, inside the capability provider, around the shell", () => {
    const source = readFileSync("src/routes/app.tsx", "utf8");
    const provider = source.indexOf("<CapabilityProvider");
    const guard = source.indexOf("<FulfillmentSensitiveCacheGuard");
    const shell = source.indexOf("<AppShell>");
    expect(provider).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(provider);
    expect(shell).toBeGreaterThan(guard);
  });
});

describe("principal changes still clear parcel-label caches", () => {
  it("a user change drops the previous user's parcel-label caches", () => {
    const queryClient = new QueryClient();
    enforceFulfillmentCachePrincipal(queryClient, USER, ORG);
    seedGrantEraCache(queryClient);
    enforceFulfillmentCachePrincipal(queryClient, OTHER_USER, ORG);
    expectNoRawPii(queryClient);
  });

  it("an organization change drops the previous organization's parcel-label caches", () => {
    const queryClient = new QueryClient();
    enforceFulfillmentCachePrincipal(queryClient, USER, ORG);
    seedGrantEraCache(queryClient);
    enforceFulfillmentCachePrincipal(queryClient, USER, OTHER_ORG);
    expect(
      queryClient.getQueryData(fulfillmentKeys.parcelLabels(USER, ORG, [ORDER_ID])),
    ).toBeUndefined();
  });

  it("clearFulfillmentQueries drops every principal's fulfillment entries", () => {
    const queryClient = new QueryClient();
    seedGrantEraCache(queryClient);
    seedGrantEraCache(queryClient, OTHER_USER, OTHER_ORG);
    clearFulfillmentQueries(queryClient);
    const dump = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .filter((q) => q.queryKey[0] === "fulfillment")
        .map((q) => q.state.data),
    );
    expect(dump).toBe("[]");
  });
});
