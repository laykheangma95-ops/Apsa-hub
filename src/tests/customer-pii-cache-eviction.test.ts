/**
 * Raw customer PII must LEAVE the React Query cache when
 * `customers.view_sensitive` is revoked — not merely be masked at render time.
 *
 * Every assertion here inspects the QueryClient directly. A fix that only
 * masked phones in components (visibleCustomerPhone) would leave the raw
 * values in the cache and fail these tests.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CustomerSensitiveCacheGuard } from "@/components/customers/CustomerSensitiveCacheGuard";
import { CapabilityFixtureProvider } from "@/hooks/use-capabilities";
import { apsiKeys, enforceApsiCachePrincipal } from "@/lib/apsi-query";
import type { UiPermissionKey } from "@/lib/capabilities";
import {
  clearCustomerQueries,
  customerKeys,
  enforceCustomerCachePrincipal,
  enforceCustomerSensitiveCache,
} from "@/lib/customers-query";
import { readFileSync } from "node:fs";

const USER = "user-1";
const ORG = "org-1";
const OTHER_USER = "user-2";
const OTHER_ORG = "org-2";

const RAW_PHONE = "+855 12 345 678";
const RAW_EMAIL = "sokha@example.com";
const RAW_ADDRESS = "Street 271, Toul Tompoung, Phnom Penh";
const RAW_VALUES = [RAW_PHONE, RAW_EMAIL, RAW_ADDRESS];

const rawCustomer = {
  id: "c1",
  name: "Sokha",
  phone: RAW_PHONE,
  email: RAW_EMAIL,
  address: RAW_ADDRESS,
  sensitiveVisible: true,
};

/** Fill every customer cache shape the app uses, as a granted member would. */
function seedGrantEraCache(queryClient: QueryClient, userId = USER, organizationId = ORG) {
  queryClient.setQueryData(customerKeys.detail(userId, organizationId, "c1"), rawCustomer);
  queryClient.setQueryData(customerKeys.list(userId, organizationId, 0), {
    items: [rawCustomer],
    total: 1,
  });
  queryClient.setQueryData(customerKeys.directory(userId, organizationId), {
    pages: [{ items: [rawCustomer], total: 1 }],
    pageParams: [0],
  });
  queryClient.setQueryData(customerKeys.directorySearch(userId, organizationId, "012", true), {
    pages: [{ items: [rawCustomer] }],
    pageParams: [0],
  });
  queryClient.setQueryData(customerKeys.search(userId, organizationId, "012", true), [rawCustomer]);
  queryClient.setQueryData(customerKeys.options(userId, organizationId), [
    { id: "c1", name: "Sokha", primary_phone: RAW_PHONE, primary_email: RAW_EMAIL },
  ]);
  queryClient.setQueryData(customerKeys.orders(userId, organizationId, "c1"), [
    { id: "o1", deliveryAddress: RAW_ADDRESS, customerPhone: RAW_PHONE },
  ]);
  queryClient.setQueryData(apsiKeys.lookup(userId, organizationId, "012", true), {
    results: [{ kind: "customer", name: "Sokha", phone: RAW_PHONE, sensitiveVisible: true }],
  });
}

/** Everything in the cache, serialized — what devtools or a careless reader would see. */
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

describe("enforceCustomerSensitiveCache — raw PII leaves the cache on revocation", () => {
  it("granted -> revoked removes every customer entry holding raw phone/email/address", () => {
    const queryClient = new QueryClient();
    enforceCustomerSensitiveCache(queryClient, USER, ORG, true);
    seedGrantEraCache(queryClient);
    // Precondition: the raw values really are in the cache while granted.
    for (const value of RAW_VALUES) expect(cacheDump(queryClient)).toContain(value);

    // Still granted: nothing is touched (ordinary caching keeps working).
    enforceCustomerSensitiveCache(queryClient, USER, ORG, true);
    expect(queryClient.getQueryData(customerKeys.detail(USER, ORG, "c1"))).toEqual(rawCustomer);

    // Revoked.
    enforceCustomerSensitiveCache(queryClient, USER, ORG, false);

    expectNoRawPii(queryClient);
    expect(queryClient.getQueryData(customerKeys.detail(USER, ORG, "c1"))).toBeUndefined();
    expect(queryClient.getQueryData(customerKeys.directory(USER, ORG))).toBeUndefined();
    expect(queryClient.getQueryData(customerKeys.search(USER, ORG, "012", true))).toBeUndefined();
    expect(queryClient.getQueryData(customerKeys.orders(USER, ORG, "c1"))).toBeUndefined();
    expect(queryClient.getQueryData(apsiKeys.lookup(USER, ORG, "012", true))).toBeUndefined();
  });

  it("a first observation of 'not allowed' also evicts (e.g. a snapshot whose refresh failed)", () => {
    const queryClient = new QueryClient();
    seedGrantEraCache(queryClient);
    enforceCustomerSensitiveCache(queryClient, USER, ORG, false);
    expectNoRawPii(queryClient);
  });

  it("entries fetched while already denied (server-masked) are kept, not thrashed", () => {
    const queryClient = new QueryClient();
    enforceCustomerSensitiveCache(queryClient, USER, ORG, true);
    enforceCustomerSensitiveCache(queryClient, USER, ORG, false);
    const masked = {
      ...rawCustomer,
      phone: "",
      email: "",
      address: undefined,
      sensitiveVisible: false,
    };
    queryClient.setQueryData(customerKeys.detail(USER, ORG, "c1"), masked);
    enforceCustomerSensitiveCache(queryClient, USER, ORG, false);
    expect(queryClient.getQueryData(customerKeys.detail(USER, ORG, "c1"))).toEqual(masked);
  });

  it("is principal-scoped: another member's partition is not this call's to touch", () => {
    const queryClient = new QueryClient();
    enforceCustomerSensitiveCache(queryClient, USER, ORG, true);
    enforceCustomerSensitiveCache(queryClient, OTHER_USER, ORG, true);
    seedGrantEraCache(queryClient, OTHER_USER, ORG);
    enforceCustomerSensitiveCache(queryClient, USER, ORG, false);
    expect(queryClient.getQueryData(customerKeys.detail(OTHER_USER, ORG, "c1"))).toEqual(
      rawCustomer,
    );
  });

  it("keeps non-sensitive Apsi answers produced without the grant", () => {
    const queryClient = new QueryClient();
    const safe = { results: [{ kind: "order", code: "A-1" }] };
    queryClient.setQueryData(apsiKeys.lookup(USER, ORG, "a-1", false), safe);
    enforceCustomerSensitiveCache(queryClient, USER, ORG, true);
    enforceCustomerSensitiveCache(queryClient, USER, ORG, false);
    expect(queryClient.getQueryData(apsiKeys.lookup(USER, ORG, "a-1", false))).toEqual(safe);
  });
});

describe("CustomerSensitiveCacheGuard — the /app wiring evicts during render", () => {
  function renderGuard(queryClient: QueryClient, permissions: readonly UiPermissionKey[]) {
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          CapabilityFixtureProvider,
          { permissions },
          createElement(CustomerSensitiveCacheGuard, { userId: USER, organizationId: ORG }, null),
        ),
      ),
    );
  }

  it("capability change from view_sensitive to none removes raw PII from the QueryClient", () => {
    const queryClient = new QueryClient();
    renderGuard(queryClient, ["customers.read", "customers.view_sensitive"]);
    seedGrantEraCache(queryClient);
    renderGuard(queryClient, ["customers.read", "customers.view_sensitive"]);
    expect(cacheDump(queryClient)).toContain(RAW_PHONE);

    renderGuard(queryClient, ["customers.read"]);
    expectNoRawPii(queryClient);
  });

  it("is mounted in the /app layout, inside the capability provider, around the shell", () => {
    const source = readFileSync("src/routes/app.tsx", "utf8");
    const provider = source.indexOf("<CapabilityProvider");
    const guard = source.indexOf("<CustomerSensitiveCacheGuard");
    const shell = source.indexOf("<AppShell>");
    expect(provider).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(provider);
    expect(shell).toBeGreaterThan(guard);
  });
});

describe("principal changes and sign-out still clear customer caches", () => {
  it("a user change drops the previous user's customer caches", () => {
    const queryClient = new QueryClient();
    // Both partitions, exactly as the /app layout enforces them.
    enforceCustomerCachePrincipal(queryClient, USER, ORG);
    enforceApsiCachePrincipal(queryClient, USER, ORG);
    seedGrantEraCache(queryClient);
    enforceCustomerCachePrincipal(queryClient, OTHER_USER, ORG);
    enforceApsiCachePrincipal(queryClient, OTHER_USER, ORG);
    expectNoRawPii(queryClient);
  });

  it("an organization change drops the previous organization's customer caches", () => {
    const queryClient = new QueryClient();
    enforceCustomerCachePrincipal(queryClient, USER, ORG);
    seedGrantEraCache(queryClient);
    enforceCustomerCachePrincipal(queryClient, USER, OTHER_ORG);
    expect(queryClient.getQueryData(customerKeys.detail(USER, ORG, "c1"))).toBeUndefined();
  });

  it("sign-out's customer clear drops every principal's customer entries", () => {
    const queryClient = new QueryClient();
    seedGrantEraCache(queryClient);
    seedGrantEraCache(queryClient, OTHER_USER, OTHER_ORG);
    clearCustomerQueries(queryClient);
    const dump = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .filter((q) => q.queryKey[0] === "customers")
        .map((q) => q.state.data),
    );
    expect(dump).toBe("[]");
    // And Settings' sign-out still clears the whole client as well.
    expect(readFileSync("src/routes/app.settings.tsx", "utf8")).toContain("queryClient.clear()");
  });
});
