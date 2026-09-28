/**
 * Customer directory, search and edit — V1 merchant completeness.
 *
 * Three layers, strongest first:
 *   1. Behaviour of the server service and the browser data layer, in an
 *      isolated process (customer-merchant-completeness.runtime.ts).
 *   2. Behaviour of the pure presentation rules the screens delegate to
 *      (src/lib/customers-view.ts) and of the real React Query cache.
 *   3. Wiring scans of the screens, because this repository has no DOM test
 *      environment. They run on comment-stripped source so prose describing a
 *      guard can never satisfy a scan for the guard.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import {
  classifyCustomerError,
  customerDirectoryBody,
  planCustomerEdit,
  CUSTOMER_NAME_MAX_LENGTH,
  CUSTOMER_PHONE_MAX_LENGTH,
} from "@/lib/customers-view";
import {
  customerKeys,
  enforceCustomerCachePrincipal,
  visibleCustomerPhone,
} from "@/lib/customers-query";
import { createFixtureCapabilityView } from "@/lib/capabilities";
import {
  filterBusinessNavConfig,
  getBusinessNavConfig,
  resolveMobileNavActiveTab,
} from "@/design-system/mobile-nav-config";

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (file: string) => stripComments(readFileSync(resolve(file), "utf8"));

const DIRECTORY = "src/routes/app.customers.index.tsx";
const CUSTOMER_360 = "src/routes/app.customers.$id.tsx";
const EDIT_SHEET = "src/components/customers/EditCustomerSheet.tsx";

it("server rules and data-layer behaviour hold in an isolated process", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/customer-merchant-completeness.runtime.ts")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 70000);

// ── Directory states ──────────────────────────────────────────────────────────

describe("the directory never turns an unanswered search into 'no such customer'", () => {
  const base = { searching: true, rowCount: 0, phoneSearchDenied: false, truncated: false };

  it("a refused phone search is its own state, even with zero rows", () => {
    expect(customerDirectoryBody({ ...base, phoneSearchDenied: true })).toBe("phone_denied");
  });

  it("a truncated phone scan with no match is 'partial', not 'no results'", () => {
    expect(customerDirectoryBody({ ...base, truncated: true })).toBe("partial_empty");
  });

  it("a complete search with no match is 'no results'", () => {
    expect(customerDirectoryBody(base)).toBe("no_results");
  });

  it("an organization with no customers is 'empty' only when not searching", () => {
    expect(customerDirectoryBody({ ...base, searching: false })).toBe("empty");
  });

  it("rows win over every negative state except a refused phone search", () => {
    expect(customerDirectoryBody({ ...base, rowCount: 3, truncated: true })).toBe("rows");
    expect(customerDirectoryBody({ ...base, rowCount: 3, searching: false })).toBe("rows");
  });
});

describe("classifyCustomerError keeps denied, missing, invalid and failed apart", () => {
  const withCode = (statusCode: number, message = "x") =>
    Object.assign(new Error(message), { statusCode });

  it("maps status codes", () => {
    expect(classifyCustomerError(withCode(401))).toBe("unauthorized");
    expect(classifyCustomerError(withCode(403))).toBe("forbidden");
    expect(classifyCustomerError(withCode(404))).toBe("not_found");
    expect(classifyCustomerError(withCode(400))).toBe("invalid");
  });

  it("falls back to the service's own messages when the code is lost", () => {
    expect(classifyCustomerError(new Error("Missing permission: customers.read"))).toBe(
      "forbidden",
    );
    expect(classifyCustomerError(new Error("Customer not found"))).toBe("not_found");
    expect(classifyCustomerError(new Error("Not authenticated"))).toBe("unauthorized");
  });

  it("anything else is a failure — never read as empty or as success", () => {
    expect(classifyCustomerError(new Error("fetch failed"))).toBe("error");
    expect(classifyCustomerError("weird")).toBe("error");
  });
});

// ── Edit plan ─────────────────────────────────────────────────────────────────

describe("planCustomerEdit sends the smallest honest request", () => {
  const current = { name: "សុខា", phone: "012 345 678" };

  it("sends nothing when nothing changed", () => {
    const plan = planCustomerEdit({ current, draft: { ...current }, canEditPhone: true });
    expect(plan.patch).toEqual({});
    expect(plan.canSubmit).toBe(false);
  });

  it("sends only the changed name, trimmed", () => {
    const plan = planCustomerEdit({
      current,
      draft: { name: "  Dara ", phone: current.phone },
      canEditPhone: true,
    });
    expect(plan.patch).toEqual({ name: "Dara" });
    expect(plan.canSubmit).toBe(true);
  });

  it("never includes the phone for a member who cannot see it, whatever the draft says", () => {
    const plan = planCustomerEdit({
      current: { name: "សុខា", phone: "" },
      draft: { name: "សុខា", phone: "099 999 999" },
      canEditPhone: false,
    });
    expect(plan.patch).toEqual({});
    expect("phone" in plan.patch).toBe(false);
    expect(plan.canSubmit).toBe(false);
  });

  it("flags removing a phone on file, and sends it as null", () => {
    const plan = planCustomerEdit({
      current,
      draft: { name: current.name, phone: "   " },
      canEditPhone: true,
    });
    expect(plan.patch).toEqual({ phone: null });
    expect(plan.removesPhone).toBe(true);
  });

  it("validates before anything is sent", () => {
    expect(
      planCustomerEdit({ current, draft: { name: " ", phone: current.phone }, canEditPhone: true })
        .errors.name,
    ).toBe("name_required");
    expect(
      planCustomerEdit({
        current,
        draft: { name: "x".repeat(CUSTOMER_NAME_MAX_LENGTH + 1), phone: current.phone },
        canEditPhone: true,
      }).canSubmit,
    ).toBe(false);
    expect(
      planCustomerEdit({
        current,
        draft: { name: current.name, phone: "1".repeat(CUSTOMER_PHONE_MAX_LENGTH + 1) },
        canEditPhone: true,
      }).errors.phone,
    ).toBe("phone_too_long");
  });
});

// ── Cache isolation and refresh ───────────────────────────────────────────────

describe("customer cache: principal-scoped, and refreshed by the writes that change it", () => {
  const A = { user: "user-a", org: "org-a" };
  const B = { user: "user-b", org: "org-a" };

  it("directory and directory-search entries sit inside the principal partition", () => {
    const principal = customerKeys.principal(A.user, A.org);
    for (const key of [
      customerKeys.directory(A.user, A.org),
      customerKeys.directorySearch(A.user, A.org, "Dara", false),
      customerKeys.orders(A.user, A.org, "c1"),
      customerKeys.detail(A.user, A.org, "c1"),
    ]) {
      expect(key.slice(0, principal.length)).toEqual([...principal]);
    }
  });

  it("a search matched with phone access is a different entry from one matched without", () => {
    expect(customerKeys.directorySearch(A.user, A.org, "012", true)).not.toEqual(
      customerKeys.directorySearch(A.user, A.org, "012", false),
    );
  });

  it("a different member in the same tab never reads the previous member's directory", () => {
    const client = new QueryClient();
    enforceCustomerCachePrincipal(client, A.user, A.org);
    client.setQueryData(customerKeys.directory(A.user, A.org), { pages: [{ phone: "012" }] });

    enforceCustomerCachePrincipal(client, B.user, B.org);
    expect(client.getQueryData(customerKeys.directory(A.user, A.org))).toBeUndefined();
  });

  it("the same principal keeps its cache", () => {
    const client = new QueryClient();
    enforceCustomerCachePrincipal(client, A.user, A.org);
    client.setQueryData(customerKeys.directory(A.user, A.org), { pages: [] });
    enforceCustomerCachePrincipal(client, A.user, A.org);
    expect(client.getQueryData(customerKeys.directory(A.user, A.org))).toEqual({ pages: [] });
  });

  it("invalidating the principal (what an edit or an order create does) refreshes directory, search and history", async () => {
    const client = new QueryClient();
    const keys = [
      customerKeys.directory(A.user, A.org),
      customerKeys.directorySearch(A.user, A.org, "Dara", true),
      customerKeys.orders(A.user, A.org, "c1"),
      customerKeys.detail(A.user, A.org, "c1"),
    ];
    for (const key of keys) client.setQueryData(key, { cached: true });
    const other = customerKeys.directory(B.user, "org-b");
    client.setQueryData(other, { cached: true });

    await client.invalidateQueries({ queryKey: customerKeys.principal(A.user, A.org) });

    for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    // Another principal's entries are not touched.
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
  });

  it("a cached phone disappears on the next render once the grant is gone", () => {
    const cached = { phone: "012 345 678", sensitiveVisible: true };
    expect(visibleCustomerPhone(cached, true)).toBe("012 345 678");
    expect(visibleCustomerPhone(cached, false)).toBe("");
  });
});

// ── Navigation ────────────────────────────────────────────────────────────────

describe("navigation reaches the directory only for members the server will serve", () => {
  it("gates the Customers entries on customers.read", () => {
    const config = getBusinessNavConfig("online-seller");
    const actions = [...config.askGroups, ...config.salesGroups].flatMap((g) => g.actions);
    const toCustomers = actions.filter((a) => a.to === "/app/customers");
    expect(toCustomers.map((a) => a.id).sort()).toEqual(["customers", "find-customer"]);
    for (const action of toCustomers) {
      expect(action.requiresAll).toEqual(["customers.read"]);
      expect(action.availability).toBe("live");
    }
  });

  it("hides them without customers.read and shows them with it", () => {
    const ids = (permissions: string[]) =>
      filterBusinessNavConfig(
        getBusinessNavConfig("online-seller"),
        createFixtureCapabilityView(permissions as never),
      )
        .salesGroups.flatMap((g) => g.actions)
        .map((a) => a.id);
    expect(ids(["orders.read"])).not.toContain("customers");
    expect(ids(["orders.read", "customers.read"])).toContain("customers");
  });

  it("highlights Sales on the directory", () => {
    expect(resolveMobileNavActiveTab("/app/customers")).toBe("sales");
  });
});

// ── Screen wiring ─────────────────────────────────────────────────────────────

describe("Customer directory screen wiring", () => {
  const src = code(DIRECTORY);

  it("reads only the production list and the server search — no fixtures", () => {
    expect(src).toContain("getCustomers({ offset: pageParam");
    expect(src).toContain("searchRealCustomers(debouncedSearch, canViewSensitive");
    expect(src).not.toMatch(/@\/lib\/mock/);
    expect(src).not.toMatch(/\.filter\(\s*\(?c(ustomer)?\)?\s*=>\s*[^)]*includes\(/);
  });

  it("gates on customers.read and uses the fail-closed sensitive reader for phones", () => {
    expect(src).toContain('capabilities.can("customers.read")');
    expect(src).toContain('capabilities.canSensitive("customers.view_sensitive")');
    expect(src).toContain("visibleCustomerPhone(customer, canViewSensitive)");
    expect(src).not.toMatch(/customer\.phone\b/);
  });

  it("keys both queries by the route guard's principal", () => {
    expect(src).toContain("customerKeys.directory(userId, routeOrganizationId)");
    expect(src).toMatch(/customerKeys\.directorySearch\(\s*userId,\s*routeOrganizationId/);
    expect(src).toContain("Route.useRouteContext()");
  });

  it("renders a distinct state for denied, error, phone-denied, partial, no-results and empty", () => {
    for (const key of [
      "customerList.denied.title",
      "customerList.error.title",
      "customerList.phoneDenied.title",
      "customerList.partialEmpty.title",
      "customerList.noResults.title",
      "customerList.empty.title",
    ]) {
      expect(src).toContain(`t("${key}")`);
    }
    expect(src).toContain("<CapabilityDeniedState");
  });
});

describe("Customer 360 edit wiring", () => {
  const detail = code(CUSTOMER_360);
  const sheet = code(EDIT_SHEET);

  it("offers Edit only for production customers to members with customers.update_basic", () => {
    expect(detail).toContain(
      'const canEdit = isProductionId(id) && capabilities.can("customers.update_basic");',
    );
  });

  it("offers the phone for editing only when it is visible to this member right now", () => {
    expect(detail).toContain("canEditPhone={sensitiveVisible}");
    expect(detail).toContain('currentPhone={sensitiveVisible ? customer.phone : ""}');
  });

  it("refreshes this principal's customer partition after a save, and the profile after any attempt", () => {
    expect(detail).toContain("queryKey: customerKeys.principal(userId, routeOrganizationId)");
    expect(detail).toMatch(
      /onSettled=\{\(\) => \{\s*void queryClient\.invalidateQueries\(\{ queryKey: detailKey \}\)/,
    );
  });

  it("reports success only after the server answered, with no optimistic write", () => {
    expect(sheet).toContain("const updated = await updateRealCustomer(customerId, plan.patch);");
    expect(sheet.indexOf("onSaved(updated)")).toBeGreaterThan(
      sheet.indexOf("await updateRealCustomer"),
    );
    expect(sheet).not.toMatch(/setQueryData/);
  });

  it("asks before removing a phone number", () => {
    expect(sheet).toContain("plan.removesPhone && !confirmingRemoval");
  });

  it("tells a denied direct-URL visit it is denied, not that the customer is gone", () => {
    expect(detail).toContain('loadError === "forbidden"');
    expect(detail).toContain('t("capability.denied.title")');
  });
});
