/**
 * Customer directory + Customer edit — behavioural checks across the server
 * service and the browser data layer.
 *
 * Isolated runtime file (spawned by customer-merchant-completeness.test.ts):
 * bun:test's mock.module mutates the shared module cache for the whole process.
 *
 * Server half: the SAME repository rows under different permission sets must
 * produce different answers — and the forbidden paths must never reach the
 * repository at all (a masked response to a write that still happened would
 * not be a gate).
 *
 * Client half: the wrappers the directory and the edit sheet call must hit the
 * real server-function boundary, send only what they should, and surface a
 * failure as a failure (never fixtures, never a fabricated success).
 *
 * Run: bun test src/tests/customer-merchant-completeness.runtime.ts
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { AuthorizationContext } from "@/server/auth/authorization";

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const CUSTOMER = "cccccccc-0000-4000-8000-00000000000c";
const PHONE = "+855 12 345 678";
const EMAIL = "sokha@example.com";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER,
    organization_id: ORG,
    display_name: "សុខា",
    primary_phone: PHONE,
    primary_email: EMAIL,
    status: "active" as const,
    language: "km",
    first_seen_at: null,
    last_seen_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── Server-side doubles ───────────────────────────────────────────────────────

const repoCalls: Array<{ fn: string; args: unknown[] }> = [];
let updateResult: ReturnType<typeof row> | null = row();
const auditWrites: Array<Record<string, unknown>> = [];

mock.module("@/server/customers/repository", () => ({
  findCustomerById: async (...args: unknown[]) => {
    repoCalls.push({ fn: "findCustomerById", args });
    return row();
  },
  listCustomers: async (...args: unknown[]) => {
    repoCalls.push({ fn: "listCustomers", args });
    return [row()];
  },
  searchCustomersByName: async (...args: unknown[]) => {
    repoCalls.push({ fn: "searchCustomersByName", args });
    return [row()];
  },
  scanCustomersWithPhone: async (...args: unknown[]) => {
    repoCalls.push({ fn: "scanCustomersWithPhone", args });
    return [row()];
  },
  updateCustomer: async (...args: unknown[]) => {
    repoCalls.push({ fn: "updateCustomer", args });
    const patch = args[2] as Record<string, unknown>;
    return updateResult ? { ...updateResult, ...patch } : null;
  },
  addCustomerIdentity: async (...args: unknown[]) => {
    repoCalls.push({ fn: "addCustomerIdentity", args });
    return { id: "identity", ...(args[2] as object) };
  },
  findIdentitiesByCustomer: async () => [],
  findAddressesByCustomer: async () => [],
  findTagsByCustomer: async () => [],
  findNotesByCustomer: async () => [],
  createCustomerNote: async () => null,
  createCustomer: async () => row(),
}));

mock.module("@/server/auth/audit", () => ({
  auditLog: async (_ctx: unknown, payload: Record<string, unknown>) => {
    auditWrites.push(payload);
  },
  auditLogRequired: async (_ctx: unknown, payload: Record<string, unknown>) => {
    auditWrites.push(payload);
  },
}));

// ── Client-side double: the server-function boundary itself ──────────────────

const sent: Array<{ fn: string; data: Record<string, unknown> }> = [];
let serverFailure: Error | null = null;

mock.module("@/api/customers", () => ({
  updateCustomerFn: async ({ data }: { data: Record<string, unknown> }) => {
    sent.push({ fn: "updateCustomerFn", data });
    if (serverFailure) throw serverFailure;
    return {
      id: data.customerId,
      nameKm: (data.display_name as string) ?? "សុខា",
      nameEn: (data.display_name as string) ?? "សុខា",
      phone: "",
      status: "active",
      sensitiveVisible: false,
    };
  },
  listCustomersFn: async ({ data }: { data: Record<string, unknown> }) => {
    sent.push({ fn: "listCustomersFn", data });
    if (serverFailure) throw serverFailure;
    const limit = data.limit as number;
    // Exactly `limit` rows: the caller asked for page + 1, so this means "more exist".
    return Array.from({ length: limit }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      nameKm: `Customer ${index}`,
      nameEn: `Customer ${index}`,
      phone: "",
      status: "active",
      sensitiveVisible: false,
    }));
  },
  searchCustomersFn: async ({ data }: { data: Record<string, unknown> }) => {
    sent.push({ fn: "searchCustomersFn", data });
    if (serverFailure) throw serverFailure;
    return {
      items: [],
      field: "name",
      hasMore: false,
      truncated: false,
      phoneSearchDenied: false,
      sensitiveVisible: false,
      limit: 20,
      offset: 0,
    };
  },
}));

const service = await import("@/server/customers/service");
const api = await import("@/lib/api");

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

/** Cashier / Sales / Customer Service: may edit basics, may not see PII. */
const basicOnly = () => contextWith(["customers.read", "customers.update_basic"]);
/** Owner / Manager. */
const withSensitive = () =>
  contextWith(["customers.read", "customers.update_basic", "customers.view_sensitive"]);

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { statusCode?: number }).statusCode;
  }
}

beforeEach(() => {
  repoCalls.length = 0;
  auditWrites.length = 0;
  sent.length = 0;
  updateResult = row();
  serverFailure = null;
});

describe("updateCustomer — server rules", () => {
  it("requires customers.update_basic and touches nothing without it", async () => {
    const status = await statusOf(
      service.updateCustomer(contextWith(["customers.read"]), CUSTOMER, { display_name: "X" }),
    );
    expect(status).toBe(403);
    expect(repoCalls).toEqual([]);
    expect(auditWrites).toEqual([]);
  });

  it("refuses a phone write from a member who cannot see phones — before any write", async () => {
    const status = await statusOf(
      service.updateCustomer(basicOnly(), CUSTOMER, { primary_phone: "099 999 999" }),
    );
    expect(status).toBe(403);
    expect(repoCalls.filter((c) => c.fn === "updateCustomer")).toEqual([]);
    expect(auditWrites).toEqual([]);
  });

  it("refuses an email write from a member who cannot see emails", async () => {
    const status = await statusOf(
      service.updateCustomer(basicOnly(), CUSTOMER, { primary_email: "x@example.com" }),
    );
    expect(status).toBe(403);
    expect(repoCalls).toEqual([]);
  });

  it("refuses clearing a phone (null) from a member who cannot see it", async () => {
    const status = await statusOf(
      service.updateCustomer(basicOnly(), CUSTOMER, { primary_phone: null }),
    );
    expect(status).toBe(403);
    expect(repoCalls).toEqual([]);
  });

  it("lets a basic member rename — and the response no longer leaks the phone or email", async () => {
    const result = await service.updateCustomer(basicOnly(), CUSTOMER, { display_name: "  Dara " });

    expect(result.nameEn).toBe("Dara");
    expect(result.phone).toBe("");
    expect(result.sensitiveVisible).toBe(false);
    // The repository row carried both values; neither may cross the boundary.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain("primary_phone");
  });

  it("returns the phone to a member who holds customers.view_sensitive", async () => {
    const result = await service.updateCustomer(withSensitive(), CUSTOMER, {
      primary_phone: " 012 000 111 ",
    });
    expect(result.phone).toBe("012 000 111");
    expect(result.sensitiveVisible).toBe(true);
  });

  it("sends only the changed, cleaned fields; an emptied phone is stored as NULL", async () => {
    await service.updateCustomer(withSensitive(), CUSTOMER, {
      display_name: " Dara ",
      primary_phone: "   ",
    });
    const call = repoCalls.find((c) => c.fn === "updateCustomer")!;
    expect(call.args[0]).toBe(ORG);
    expect(call.args[1]).toBe(CUSTOMER);
    expect(call.args[2]).toEqual({ display_name: "Dara", primary_phone: null });
  });

  it("rejects an empty patch and a blank name as 400 without writing", async () => {
    expect(await statusOf(service.updateCustomer(withSensitive(), CUSTOMER, {}))).toBe(400);
    expect(
      await statusOf(service.updateCustomer(withSensitive(), CUSTOMER, { display_name: "  " })),
    ).toBe(400);
    expect(repoCalls).toEqual([]);
  });

  it("reports another organization's (or an unknown) customer as 404", async () => {
    updateResult = null;
    expect(
      await statusOf(service.updateCustomer(withSensitive(), CUSTOMER, { display_name: "X" })),
    ).toBe(404);
    expect(auditWrites).toEqual([]);
  });

  it("audits which fields changed, never their values", async () => {
    await service.updateCustomer(withSensitive(), CUSTOMER, {
      display_name: "Dara",
      primary_phone: "011 222 333",
    });
    expect(auditWrites).toHaveLength(1);
    const audit = auditWrites[0]!;
    expect(audit.action).toBe("customers.update");
    expect(audit.resourceId).toBe(CUSTOMER);
    expect(audit.afterJson).toEqual({ fields: ["display_name", "primary_phone"] });
    expect(JSON.stringify(audit)).not.toContain("011 222 333");
  });

  it("still requires customers.archive to archive", async () => {
    expect(
      await statusOf(service.updateCustomer(withSensitive(), CUSTOMER, { status: "archived" })),
    ).toBe(403);
  });
});

describe("addIdentityToCustomer — phone/email identities follow the same rule", () => {
  it("refuses a PHONE identity from a member who cannot see phones, before any read", async () => {
    const status = await statusOf(
      service.addIdentityToCustomer(basicOnly(), CUSTOMER, {
        provider: "PHONE",
        provider_user_id: "012345678",
      }),
    );
    expect(status).toBe(403);
    expect(repoCalls).toEqual([]);
  });

  it("refuses an EMAIL identity likewise", async () => {
    const status = await statusOf(
      service.addIdentityToCustomer(basicOnly(), CUSTOMER, {
        provider: "EMAIL",
        provider_user_id: "x@example.com",
      }),
    );
    expect(status).toBe(403);
  });

  it("leaves social identities on customers.update_basic, unchanged", async () => {
    await service.addIdentityToCustomer(basicOnly(), CUSTOMER, {
      provider: "TELEGRAM",
      provider_user_id: "777",
    });
    expect(repoCalls.map((c) => c.fn)).toEqual(["findCustomerById", "addCustomerIdentity"]);
  });
});

describe("directory reads — the list and search a directory row is built from", () => {
  it("the list masks the phone for a member without customers.view_sensitive", async () => {
    const rows = await service.listCustomers(basicOnly());
    expect(rows[0]?.phone).toBe("");
    expect(JSON.stringify(rows)).not.toContain(PHONE);
  });

  it("a phone-shaped search from such a member is refused without scanning phones", async () => {
    const page = await service.searchCustomers(basicOnly(), { query: "012 345 678" });
    expect(page.phoneSearchDenied).toBe(true);
    expect(page.items).toEqual([]);
    expect(repoCalls.map((c) => c.fn)).not.toContain("scanCustomersWithPhone");
  });

  it("a name search never returns a masked member the phone", async () => {
    const page = await service.searchCustomers(basicOnly(), { query: "សុខា" });
    expect(page.field).toBe("name");
    expect(JSON.stringify(page)).not.toContain(PHONE);
  });
});

describe("browser data layer — real server functions, honest failures", () => {
  it("updateRealCustomer refuses a non-production id without calling the server", async () => {
    await expect(api.updateRealCustomer("cus-1", { name: "X" })).rejects.toThrow(
      "invalid_reference",
    );
    expect(sent).toEqual([]);
  });

  it("updateRealCustomer sends only what changed and never an organization", async () => {
    await api.updateRealCustomer(CUSTOMER, { name: "Dara" });
    expect(sent).toEqual([
      { fn: "updateCustomerFn", data: { customerId: CUSTOMER, display_name: "Dara" } },
    ]);
  });

  it("updateRealCustomer sends a phone removal as null", async () => {
    await api.updateRealCustomer(CUSTOMER, { phone: null });
    expect(sent[0]!.data).toEqual({ customerId: CUSTOMER, primary_phone: null });
  });

  it("updateRealCustomer surfaces a refusal instead of reporting success", async () => {
    serverFailure = Object.assign(new Error("Missing permission: customers.view_sensitive"), {
      statusCode: 403,
    });
    await expect(api.updateRealCustomer(CUSTOMER, { phone: "012" })).rejects.toThrow(
      "Missing permission",
    );
  });

  it("getCustomers asks for page + 1 to learn hasMore, passes the offset, active only", async () => {
    const page = await api.getCustomers({ offset: 50, limit: 50 });
    expect(sent).toEqual([
      { fn: "listCustomersFn", data: { limit: 51, offset: 50, status: "active" } },
    ]);
    expect(page.customers).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    expect(page.offset).toBe(50);
  });

  it("getCustomers propagates a failure — never an empty directory, never fixtures", async () => {
    serverFailure = new Error("database unavailable");
    await expect(api.getCustomers({ offset: 0, limit: 50 })).rejects.toThrow(
      "database unavailable",
    );
  });

  it("a phone-shaped directory search from a masked member never leaves the browser", async () => {
    const page = await api.searchRealCustomers("012 345 678", false, { offset: 0 });
    expect(page.phoneSearchDenied).toBe(true);
    expect(page.customers).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("a name search goes to the server, with the offset for 'show more'", async () => {
    await api.searchRealCustomers("Dara", false, { offset: 20 });
    expect(sent).toEqual([
      { fn: "searchCustomersFn", data: { query: "Dara", limit: 20, offset: 20 } },
    ]);
  });
});
