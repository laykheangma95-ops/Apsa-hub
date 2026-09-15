/**
 * customers.view_sensitive — server-side gate on customer PII.
 *
 * Isolated runtime file (spawned by customer-sensitive-gate.test.ts) for the
 * same reason as capabilities-server.runtime.ts: bun:test's mock.module
 * mutates the shared module cache for the whole process.
 *
 * Why this file exists: the rule that a caller without
 * `customers.view_sensitive` never receives a phone number or a postal
 * address is stated in src/server/customers/service.ts and relied on by the
 * UI (which only ever reads the server's `sensitiveVisible` flag). It had no
 * behavioural coverage — the gate could be replaced with a constant `true`,
 * handing every caller every customer's phone and address, and the whole
 * suite still passed. These tests assert the gate from the outside: same
 * repository rows, two different permission sets, two different payloads.
 *
 * Run: bun test src/tests/customer-sensitive-gate.runtime.ts
 */
import { describe, expect, it, mock } from "bun:test";
import { AuthorizationContext } from "@/server/auth/authorization";

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const CUSTOMER = "cccccccc-0000-4000-8000-00000000000c";
const PHONE = "+855 12 345 678";

const customerRow = {
  id: CUSTOMER,
  organization_id: ORG,
  display_name: "សុខា",
  primary_phone: PHONE,
  primary_email: null,
  status: "active" as const,
  language: "km",
  first_seen_at: null,
  last_seen_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const addressRow = {
  id: "dddddddd-0000-4000-8000-00000000000d",
  organization_id: ORG,
  customer_id: CUSTOMER,
  is_default: true,
  label: "Home",
  house_no: "12",
  street: "Street 240",
  sangkat: "Chaktomuk",
  khan: "Daun Penh",
  city: "Phnom Penh",
  province: "Phnom Penh",
  country: "KH",
  landmark: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

mock.module("@/server/customers/repository", () => ({
  findCustomerById: async () => customerRow,
  findIdentitiesByCustomer: async () => [],
  findAddressesByCustomer: async () => [addressRow],
  findTagsByCustomer: async () => [],
  findNotesByCustomer: async () => [],
  listCustomers: async () => [customerRow],
}));

const { getCustomer360, listCustomers } = await import("@/server/customers/service");

/** A context holding exactly the permissions named — nothing is implied. */
function contextWith(permissions: string[]): AuthorizationContext {
  return new AuthorizationContext({
    membership: {
      user_id: "eeeeeeee-0000-4000-8000-00000000000e",
      organization_id: ORG,
      role_id: "ffffffff-0000-4000-8000-00000000000f",
    },
    role: { system_role: null },
    permissions: new Set(permissions),
  } as never);
}

const withSensitive = () => contextWith(["customers.read", "customers.view_sensitive"]);
const withoutSensitive = () => contextWith(["customers.read"]);

describe("customers.view_sensitive gates customer PII server-side", () => {
  it("withholds the phone number from Customer 360 when the permission is absent", async () => {
    const result = await getCustomer360(withoutSensitive(), CUSTOMER);

    expect(result.customer.phone).toBe("");
    expect(JSON.stringify(result)).not.toContain(PHONE);
  });

  it("withholds the postal address from Customer 360 when the permission is absent", async () => {
    const result = await getCustomer360(withoutSensitive(), CUSTOMER);

    expect(result.customer.address).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("Street 240");
  });

  it("reports sensitiveVisible=false so the UI never has to infer the gate itself", async () => {
    const result = await getCustomer360(withoutSensitive(), CUSTOMER);

    expect(result.customer.sensitiveVisible).toBe(false);
  });

  it("returns the phone and address to a caller that does hold the permission", async () => {
    const result = await getCustomer360(withSensitive(), CUSTOMER);

    expect(result.customer.phone).toBe(PHONE);
    expect(result.customer.sensitiveVisible).toBe(true);
    expect(result.customer.address).toBeDefined();
  });

  it("withholds the phone number from the customer LIST as well as the detail", async () => {
    const denied = await listCustomers(withoutSensitive());
    const allowed = await listCustomers(withSensitive());

    expect(denied[0]?.phone).toBe("");
    expect(denied[0]?.sensitiveVisible).toBe(false);
    expect(JSON.stringify(denied)).not.toContain(PHONE);

    // Same rows from the same repository — only the permission differs.
    expect(allowed[0]?.phone).toBe(PHONE);
    expect(allowed[0]?.sensitiveVisible).toBe(true);
  });
});
