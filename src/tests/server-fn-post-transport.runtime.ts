/**
 * Server-function transport — the critical fulfillment mutations travel as
 * POST with their payload in the body, and the server boundary still
 * authenticates, resolves the tenant server-side, validates, and refuses.
 *
 * What is REAL here:
 *   - TanStack Start's own `createServerFn` (start-client-core), so the method
 *     default ("GET" when omitted) is the installed framework's, not ours;
 *   - the real client RPC path the Vite compiler emits on the client:
 *     `.handler(createClientRpc(id))` → executeMiddleware("client") →
 *     serverFnFetcher → fetch — so the observed Request (method, URL, body) is
 *     byte-for-byte what a browser would send;
 *   - every src/api/* validator and handler under test, unchanged.
 *
 * What is stubbed: the network (a fetch stand-in plays the server: it enforces
 * the registered method exactly like start-server-core's handleServerAction —
 * 405 on mismatch — decodes the body with seroval, then runs the real
 * validator + handler), the cookie session, the active-membership lookup, and
 * the domain services (recording fakes). Service-level permission and tenant
 * enforcement against real SQL are proven by the domain suites
 * (order-domain, delivery-domain, courier-handoff, parcel-recovery-pg,
 * parcel-tenant-isolation, scan-to-pack-security).
 *
 * Isolated in its own process because it replaces modules process-globally.
 * Spawned by server-fn-post-transport.test.ts.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createServerFn as realCreateServerFn } from "@tanstack/start-client-core";
import { createClientRpc } from "@tanstack/start-client-core/client-rpc";
import { runWithStartContext } from "@tanstack/start-storage-context";
import { fromJSON, toCrossJSONAsync } from "seroval";

process.env["TSS_SERVER_FN_BASE"] = "/_serverFn/";

// ── Registry of server functions built by the (real) factory ────────────────

interface Registered {
  id: string;
  method: string;
  validator: ((data: unknown) => unknown) | undefined;
  handler: (args: { data: unknown }) => unknown;
}
const registry = new Map<string, Registered>();
let nextId = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Builder = any;

/**
 * Wraps the REAL builder. `.handler(fn)` does what the client compile does —
 * `.handler(createClientRpc(id))` — and keeps `fn` for the stub server.
 */
function wrap(builder: Builder, validator?: (data: unknown) => unknown): Builder {
  return {
    validator: (v: (data: unknown) => unknown) => wrap(builder.validator(v), v),
    inputValidator: (v: (data: unknown) => unknown) => wrap(builder.inputValidator(v), v),
    handler: (fn: (args: { data: unknown }) => unknown) => {
      const id = `fn${++nextId}`;
      const clientFn = builder.handler(createClientRpc(id));
      registry.set(id, { id, method: builder.options.method, validator, handler: fn });
      return Object.assign(clientFn, { __testId: id });
    },
  };
}

mock.module("@tanstack/react-start", () => ({
  createServerFn: (options?: Record<string, unknown>) => wrap(realCreateServerFn(options)),
}));

// ── Server-side collaborators ────────────────────────────────────────────────

const USER = "11111111-1111-4111-8111-111111111111";
const SERVER_ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_ORG = "bbbbbbbb-0000-4000-8000-000000000001";

let session: { userId: string; email: string; emailVerified: boolean; accessToken: string } | null;
let activeOrg: string | null;
let permissions: Set<string>;

class UnauthorizedError extends Error {
  statusCode = 401;
}
class ForbiddenError extends Error {
  statusCode = 403;
}

mock.module("@/api/auth", () => ({ getSessionFn: async () => session }));
mock.module("@/server/auth/active-organization", () => ({
  resolveActiveOrganizationId: async () => activeOrg,
}));
mock.module("@/server/auth/authorization", () => ({
  UnauthorizedError,
  ForbiddenError,
  AuthorizationContext: class {},
  AuthorizationService: {
    forRequest: async (userId: string, organizationId: string) => ({
      userId,
      organizationId,
      permissions,
    }),
  },
}));

interface ServiceCall {
  service: string;
  ctx: { userId: string; organizationId: string };
  args: unknown[];
}
const calls: ServiceCall[] = [];

/** A recording fake that, like the real services, refuses without the permission. */
function fakeService(service: string, permission: string) {
  return async (ctx: ServiceCall["ctx"] & { permissions: Set<string> }, ...args: unknown[]) => {
    if (!ctx.permissions.has(permission)) throw new ForbiddenError(`Missing ${permission}`);
    calls.push({ service, ctx: { userId: ctx.userId, organizationId: ctx.organizationId }, args });
    return { ok: true, service };
  };
}

mock.module("@/server/orders/service", () => ({
  createOrder: fakeService("createOrder", "orders.create"),
  recoverOrderParcel: fakeService("recoverOrderParcel", "orders.confirm"),
}));
mock.module("@/server/deliveries/service", () => ({
  createDelivery: fakeService("createDelivery", "deliveries.create"),
  markDeliveryInTransit: fakeService("markDeliveryInTransit", "deliveries.update"),
}));
mock.module("@/server/handoff/service", () => ({
  confirmHandoff: fakeService("confirmHandoff", "deliveries.update"),
}));
mock.module("@/server/packing/service", () => ({
  markOrderPacked: fakeService("markOrderPacked", "orders.pack"),
}));

// ── The wire ─────────────────────────────────────────────────────────────────

interface Wire {
  method: string;
  url: string;
  body: string;
}
const wire: Wire[] = [];

/** Plays start-server-core's handleServerAction for the registered function. */
async function stubServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(new URL(String(input), "https://apsa.test"), init);
  const body = request.method === "GET" ? "" : await request.clone().text();
  wire.push({ method: request.method, url: request.url, body });

  const id = new URL(request.url).pathname.replace("/_serverFn/", "");
  const fn = registry.get(id);
  if (!fn) return new Response("not found", { status: 404 });
  // The installed framework's gate (server-functions-handler.js).
  if (request.method !== fn.method) {
    return new Response(`expected ${fn.method} method. Got ${request.method}`, {
      status: 405,
      headers: { Allow: fn.method, "content-type": "text/plain" },
    });
  }
  const raw = request.method === "GET" ? new URL(request.url).searchParams.get("payload") : body;
  const payload = raw ? (fromJSON(JSON.parse(raw)) as { data?: unknown }) : undefined;

  let res: { result?: unknown; error?: unknown; context: Record<string, never> };
  try {
    const data = fn.validator ? fn.validator(payload?.data) : payload?.data;
    res = { result: await fn.handler({ data }), context: {} };
  } catch (error) {
    res = { error, context: {} };
  }
  const status = res.error ? ((res.error as { statusCode?: number }).statusCode ?? 500) : 200;
  return new Response(
    JSON.stringify(await toCrossJSONAsync(res.error ?? res, { refs: new Map() })),
    {
      status,
      headers: { "content-type": "application/json", "x-tss-serialized": "true" },
    },
  );
}
globalThis.fetch = stubServer as typeof fetch;

/** Calls a server function through the real client path. */
function call<T>(fn: (opts: { data: unknown }) => Promise<T>, data: unknown): Promise<T> {
  return runWithStartContext({ startOptions: {} } as never, () => fn({ data }));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORDER = "22222222-2222-4222-8222-222222222222";
const VARIANT = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const DELIVERY = "55555555-5555-4555-8555-555555555555";
const PARCEL = "APX-7Q4K-M2RD";
const PHONE = "+85512345678";
const ADDRESS = "St 271 Toul Tom Poung";
const TRACKING = "TRK-FIXTURE-998877";
const TEST_IDEMPOTENCY_KEY = "fixture-aaaaaaaaaaaaaaaa";

const { createOrderFn, recoverOrderParcelFn } = await import("@/api/orders");
const { createDeliveryFn, markDeliveryInTransitFn } = await import("@/api/deliveries");
const { confirmHandoffFn } = await import("@/api/handoff");
const { markOrderPackedFn } = await import("@/api/packing");

interface Case {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: any;
  service: string;
  permission: string;
  valid: Record<string, unknown>;
  invalid: Record<string, unknown>;
  /** Values that must never appear in the URL. */
  sensitive: string[];
}

const cases: Case[] = [
  {
    name: "Create Order",
    fn: createOrderFn,
    service: "createOrder",
    permission: "orders.create",
    valid: {
      source: "FACEBOOK",
      items: [{ variantId: VARIANT, quantity: 2 }],
      idempotencyKey: TEST_IDEMPOTENCY_KEY,
      deliveryMinor: 150,
      shipping: { name: "Sokha", phone: PHONE, address: ADDRESS },
    },
    invalid: { source: "FACEBOOK", items: [], idempotencyKey: TEST_IDEMPOTENCY_KEY },
    sensitive: [PHONE, ADDRESS, "Sokha", VARIANT, TEST_IDEMPOTENCY_KEY],
  },
  {
    name: "Create Delivery",
    fn: createDeliveryFn,
    service: "createDelivery",
    permission: "deliveries.create",
    valid: { orderId: ORDER, externalTrackingNumber: TRACKING, codAmountMinor: 2500 },
    invalid: { orderId: "not-a-uuid" },
    sensitive: [ORDER, TRACKING, "2500"],
  },
  {
    name: "Delivery transition (in transit)",
    fn: markDeliveryInTransitFn,
    service: "markDeliveryInTransit",
    permission: "deliveries.update",
    valid: { deliveryId: DELIVERY, reason: "picked up" },
    invalid: { deliveryId: "x" },
    sensitive: [DELIVERY, "picked up"],
  },
  {
    name: "Courier Handoff",
    fn: confirmHandoffFn,
    service: "confirmHandoff",
    permission: "deliveries.update",
    valid: { parcelCode: PARCEL },
    invalid: { parcelCode: "" },
    sensitive: [PARCEL],
  },
  {
    name: "Recover APSA Parcel",
    fn: recoverOrderParcelFn,
    service: "recoverOrderParcel",
    permission: "orders.confirm",
    valid: { orderId: ORDER },
    invalid: { orderId: "nope" },
    sensitive: [ORDER],
  },
  {
    name: "Mark Packed",
    fn: markOrderPackedFn,
    service: "markOrderPacked",
    permission: "orders.pack",
    valid: { orderId: ORDER, packedLines: [{ orderItemId: ITEM, quantity: 1 }] },
    invalid: { orderId: ORDER, packedLines: [] },
    sensitive: [ORDER, ITEM],
  },
];

beforeEach(() => {
  session = { userId: USER, email: "staff@test.invalid", emailVerified: true, accessToken: "t" };
  activeOrg = SERVER_ORG;
  permissions = new Set(cases.map((c) => c.permission));
  calls.length = 0;
  wire.length = 0;
});

function lastWire(): Wire {
  expect(wire.length).toBe(1);
  return wire[0]!;
}

for (const c of cases) {
  describe(c.name, () => {
    it("is declared POST through the real TanStack factory", () => {
      expect(registry.get(c.fn.__testId)?.method).toBe("POST");
      expect(c.fn.method).toBe("POST");
    });

    it("sends POST with the payload in the body, never in the URL", async () => {
      await call(c.fn, c.valid);
      const sent = lastWire();
      expect(sent.method).toBe("POST");
      const url = new URL(sent.url);
      expect(url.search).toBe("");
      expect(url.searchParams.has("payload")).toBe(false);
      for (const value of c.sensitive) {
        expect(sent.url).not.toContain(value);
        expect(decodeURIComponent(sent.url)).not.toContain(value);
        expect(sent.body).toContain(value);
      }
    });

    it("still mutates: the service runs once with the server-resolved tenant", async () => {
      const result = await call(c.fn, { ...c.valid, organizationId: OTHER_ORG });
      expect(result).toEqual({ ok: true, service: c.service });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.service).toBe(c.service);
      // A client-supplied organizationId is never the tenant.
      expect(calls[0]!.ctx).toEqual({ userId: USER, organizationId: SERVER_ORG });
      expect(JSON.stringify(calls[0]!.args)).not.toContain(OTHER_ORG);
    });

    it("still enforces the permission", async () => {
      permissions = new Set();
      await expect(call(c.fn, c.valid)).rejects.toThrow(`Missing ${c.permission}`);
      expect(calls).toHaveLength(0);
    });

    it("still refuses an unauthenticated caller before any service runs", async () => {
      session = null;
      await expect(call(c.fn, c.valid)).rejects.toThrow("Not authenticated");
      expect(calls).toHaveLength(0);
    });

    it("still refuses a caller without an active membership", async () => {
      activeOrg = null;
      await expect(call(c.fn, c.valid)).rejects.toThrow("No active organization membership");
      expect(calls).toHaveLength(0);
    });

    it("still rejects invalid input before any service runs", async () => {
      await expect(call(c.fn, c.invalid)).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("a GET to this function is refused with 405 and runs nothing", async () => {
      const id = c.fn.__testId as string;
      const encoded = encodeURIComponent(JSON.stringify({ t: 0 }));
      const response = await stubServer(`/_serverFn/${id}?payload=${encoded}`, { method: "GET" });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
      expect(calls).toHaveLength(0);
    });
  });
}

describe("control: the framework default really is GET-with-query-payload", () => {
  it("an un-annotated createServerFn sends its payload in the URL", async () => {
    const { createServerFn } = await import("@tanstack/react-start");
    const probe = createServerFn()
      .validator((d: unknown) => d)
      .handler(async () => "ok") as unknown as (o: { data: unknown }) => Promise<unknown>;
    await call(probe, { phone: PHONE });
    const sent = lastWire();
    expect(sent.method).toBe("GET");
    expect(new URL(sent.url).searchParams.has("payload")).toBe(true);
    expect(decodeURIComponent(sent.url)).toContain(PHONE);
  });
});
