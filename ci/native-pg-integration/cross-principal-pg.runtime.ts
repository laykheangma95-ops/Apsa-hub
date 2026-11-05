/**
 * Cross-principal A → B → A on REAL PostgreSQL — the integrated application
 * (main + PR #121 + PR #128) through its production server services.
 *
 * Runs inside the integration tree built by integrate.sh. The order and
 * delivery services, the real AuthorizationContext, the real audit writer and
 * the real rate limiter run unmodified; only the Supabase admin client is
 * replaced by a thin PostgREST-shaped transport over a throwaway PostgreSQL
 * database with the complete migration chain (001 → 063). Audit rows and
 * rate-limit tokens are REAL rows in that database. Synthetic data only.
 *
 * The server derives the acting principal (ctx) from the session at handling
 * time. Each case below starts a request as principal A (its
 * expectedPrincipal, PR #121), lets the server's principal become B (member or
 * organization switch), and then returns to A:
 *
 *   while B: refused 409 principal_changed, and the WHOLE write surface is
 *            byte-for-byte unchanged (orders, items, ledger, status and
 *            delivery history, deliveries, payments, audit, rate-limit tokens)
 *   back to A: the same request runs exactly once, attributed to A
 *
 * for: cancellation, courier handoff, delivery completion, counter handoff and
 * order creation (replay by idempotency key). Also: an honest principal of
 * organization B naming A's order id (IDOR) is 404 with nothing written; a
 * request without a principal is 428; and a cancellation after a refused
 * cross-principal handoff/completion still obeys PR #128's custody rule.
 *
 * Run (inside the integration tree):
 *   APSA_TEST_PG_URL=postgres://postgres@localhost:5432/postgres \
 *     bun test ./src/tests/native-pg-integration/cross-principal-pg.runtime.ts
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";
import { AuthorizationContext } from "../../server/auth/authorization";

const ADMIN_URL = process.env["APSA_TEST_PG_URL"];
if (!ADMIN_URL) throw new Error("APSA_TEST_PG_URL is required");

const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000c1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000c1";
const MEMBER_A1 = "aaaaaaaa-0000-4000-8000-0000000000c2";
const MEMBER_A2 = "aaaaaaaa-0000-4000-8000-0000000000c3";
const MEMBER_B1 = "bbbbbbbb-0000-4000-8000-0000000000c2";
const PRODUCT = "aaaaaaaa-7777-4000-8000-0000000000c1";
const VARIANT = "aaaaaaaa-5555-4000-8000-0000000000c1";
const LOCATION = "aaaaaaaa-3333-4000-8000-0000000000c1";

const ALL = [
  "orders.read",
  "orders.create",
  "orders.confirm",
  "orders.update",
  "orders.cancel",
  "delivery.read",
  "delivery.create",
  "delivery.update",
];

const dbName = `apsa_cross_principal_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: SQL;
let sql: SQL;

type Json = Record<string, unknown>;
type Principal = { userId: string; organizationId: string };

// ── PostgREST-shaped transport over the throwaway database ───────────────────

const identifier = (value: string) => {
  if (!/^[a-z_0-9]+$/.test(value)) throw new Error(`Invalid test identifier: ${value}`);
  return value;
};
const plain = (rows: unknown) => JSON.parse(JSON.stringify(rows));

function select(table: string) {
  const where: string[] = [];
  const values: unknown[] = [];
  const ordering: string[] = [];
  let columns = "*";
  let mode: "many" | "single" | "maybe" = "many";
  let limit: number | undefined;
  let offset: number | undefined;
  const param = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const chain = {
    select(cols = "*") {
      if (!/^[a-z_0-9, *]+$/.test(cols)) throw new Error(`Unsupported select: ${cols}`);
      columns = cols;
      return chain;
    },
    eq(key: string, value: unknown) {
      where.push(`${identifier(key)} = ${param(value)}`);
      return chain;
    },
    neq(key: string, value: unknown) {
      where.push(`${identifier(key)} <> ${param(value)}`);
      return chain;
    },
    in(key: string, list: unknown[]) {
      where.push(`${identifier(key)}::text = any(${param(list.map(String))}::text[])`);
      return chain;
    },
    order(key: string, options?: { ascending?: boolean }) {
      ordering.push(`${identifier(key)} ${options?.ascending === false ? "desc" : "asc"}`);
      return chain;
    },
    limit(n: number) {
      limit = n;
      return chain;
    },
    range(from: number, to: number) {
      offset = from;
      limit = to - from + 1;
      return chain;
    },
    single() {
      mode = "single";
      return chain;
    },
    maybeSingle() {
      mode = "maybe";
      return chain;
    },
    async execute() {
      let text = `select ${columns} from ${table}`;
      if (where.length) text += ` where ${where.join(" and ")}`;
      if (ordering.length) text += ` order by ${ordering.join(",")}`;
      if (limit !== undefined) text += ` limit ${limit}`;
      if (offset !== undefined) text += ` offset ${offset}`;
      try {
        const rows = plain(await sql.unsafe(text, values)) as Json[];
        if (mode === "many") return { data: rows, error: null };
        if (rows.length === 1) return { data: rows[0], error: null };
        if (mode === "maybe" && rows.length === 0) return { data: null, error: null };
        return { data: null, error: { code: "PGRST116", message: `${rows.length} rows` } };
      } catch (error) {
        return { data: null, error: { message: String(error) } };
      }
    },
    then(ok: (value: unknown) => unknown, fail?: (reason: unknown) => unknown) {
      return chain.execute().then(ok, fail);
    },
  };
  return chain;
}

const transport = {
  from(table: string) {
    const name = identifier(table);
    return {
      ...select(name),
      async insert(row: Json) {
        const keys = Object.keys(row).map(identifier);
        const text = `insert into ${name}(${keys.join(",")}) values(${keys
          .map((_, i) => `$${i + 1}`)
          .join(",")})`;
        try {
          await sql.unsafe(
            text,
            keys.map((k) => row[k]),
          );
          return { data: null, error: null };
        } catch (error) {
          return { data: null, error: { message: String(error) } };
        }
      },
    };
  },
  async rpc(name: string, input: Record<string, unknown>) {
    const entries = Object.entries(input);
    const text = `select ${identifier(name)}(${entries
      .map(([key], i) => `${identifier(key)} => $${i + 1}`)
      .join(",")}) as result`;
    try {
      const rows = await sql.unsafe(
        text,
        entries.map(([, value]) => value),
      );
      return { data: plain(rows[0].result), error: null };
    } catch (error) {
      return { data: null, error: { message: String(error) } };
    }
  },
};

mock.module("../../lib/supabase/server", () => ({ supabaseAdmin: transport }));

// ── database ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  admin = new SQL(ADMIN_URL);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  sql = new SQL({ url: url.toString(), max: 10 });

  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
    END $$;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
  `);
  for (const name of readdirSync("supabase/migrations")
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort()) {
    try {
      await sql.unsafe(readFileSync(`supabase/migrations/${name}`, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }

  for (const [id, email] of [
    [MEMBER_A1, "a1@test.invalid"],
    [MEMBER_A2, "a2@test.invalid"],
    [MEMBER_B1, "b1@test.invalid"],
  ]) {
    await sql`insert into auth.users(id,email) values(${id},${email})`;
  }
  await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
    values(${ORG_A},'A','A','principal-a',${MEMBER_A1}),(${ORG_B},'B','B','principal-b',${MEMBER_B1})`;
  await sql`insert into products(id,organization_id,name_km) values(${PRODUCT},${ORG_A},'ផលិតផល')`;
  await sql`insert into product_variants(id,organization_id,product_id,price_amount)
    values(${VARIANT},${ORG_A},${PRODUCT},1000)`;
  await sql`insert into locations(id,organization_id,name) values(${LOCATION},${ORG_A},'Shop')`;
  await sql`insert into inventory_movements(organization_id,product_id,variant_id,location_id,quantity_delta,movement_type)
    values(${ORG_A},${PRODUCT},${VARIANT},${LOCATION},1000,'initial')`;
}, 180_000);

afterAll(async () => {
  await sql?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.close();
});

// ── principals ──────────────────────────────────────────────────────────────

/** What the SERVER derived for this request (session + active organization). */
function server(userId: string, organizationId: string, permissions = ALL) {
  return new AuthorizationContext({
    membership: { user_id: userId, organization_id: organizationId, role_id: "role" },
    role: { system_role: null },
    permissions: new Set(permissions),
  } as unknown as ConstructorParameters<typeof AuthorizationContext>[0]);
}
const A1: Principal = { userId: MEMBER_A1, organizationId: ORG_A };

const orders = () => import("../../server/orders/service");
const deliveries = () => import("../../server/deliveries/service");

// ── observations ────────────────────────────────────────────────────────────

/** The complete write surface these flows can touch, as one comparable value. */
async function writeSurface() {
  const [r] = await sql`select
    (select coalesce(json_agg(o order by o.id), '[]') from (
       select id, organization_id, lifecycle_status, fulfillment_status, payment_status,
              created_by, total_minor from orders) o) as orders,
    (select count(*)::int from order_items) as "orderItems",
    (select coalesce(json_agg(m order by m.id), '[]') from (
       select id, movement_type, quantity_delta, reference_id from inventory_movements) m) as ledger,
    (select count(*)::int from order_status_history) as "orderHistory",
    (select coalesce(json_agg(d order by d.id), '[]') from (
       select id, status from deliveries) d) as deliveries,
    (select count(*)::int from delivery_status_history) as "deliveryHistory",
    (select count(*)::int from payments) as payments,
    (select count(*)::int from audit_logs) as audit,
    (select coalesce(json_agg(b order by b), '[]') from (
       select to_jsonb(rb) - 'updated_at' as b from rate_limit_buckets rb) x) as "rateLimit"`;
  return plain(r) as Json;
}

const onHand = async () => {
  const [r] = await sql`select coalesce(sum(quantity_delta),0)::int as v
    from inventory_movements where variant_id = ${VARIANT}`;
  return Number(r!.v);
};

async function auditRows(resourceId: string) {
  return plain(
    await sql`select action, organization_id, actor_user_id from audit_logs
      where resource_id = ${resourceId} order by created_at, id`,
  ) as { action: string; organization_id: string; actor_user_id: string }[];
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as Error & { statusCode?: number; code?: string };
  }
  throw new Error("expected the request to be refused");
}

/** Refused as principal_changed, and nothing anywhere was written. */
async function expectRefusedWithoutWrites(request: () => Promise<unknown>) {
  const before = await writeSurface();
  const error = await refusal(request());
  expect(error.statusCode).toBe(409);
  expect(error.code).toBe("principal_changed");
  expect(await writeSurface()).toEqual(before);
}

// ── fixtures, made as A through the same services ───────────────────────────

async function confirmedOrderAsA1(): Promise<string> {
  const svc = await orders();
  const created = await svc.createOrder(server(MEMBER_A1, ORG_A), {
    source: "POS",
    items: [{ variantId: VARIANT, quantity: 2 }],
    locationId: LOCATION,
    idempotencyKey: `harness_${crypto.randomUUID().replaceAll("-", "")}`,
    expectedPrincipal: A1,
  } as Parameters<typeof svc.createOrder>[1]);
  await svc.transitionLifecycleStatus(server(MEMBER_A1, ORG_A), created.id, "confirmed", null, A1);
  return created.id;
}

async function deliveryAsA1(orderId: string, to: "ready" | "in_transit"): Promise<string> {
  const [created] = await sql`select create_delivery_v1(${ORG_A}::uuid, ${orderId}::uuid,
      ${MEMBER_A1}::uuid, null, null, null, 'Courier', null, null) as r`;
  const d = (created!.r as Json)["delivery_id"] as string;
  const chain = ["pending", "preparing", "ready", "in_transit"];
  for (let i = 0; chain[i] !== to; i++) {
    const [r] = await sql`select transition_delivery_status_v1(${ORG_A}::uuid, ${d}::uuid,
        ${chain[i]!}, ${chain[i + 1]!}, ${MEMBER_A1}::uuid,
        ${chain[i + 1] === "ready" ? "pack_order_packed" : null}) as r`;
    expect((r!.r as Json)["status"]).toBe("success");
  }
  return d;
}

// ═════════════════════════════════════════════════════════════════════════════

describe("A → B → A: cancellation", () => {
  it("organization switch: refused while B, nothing written; back in A it cancels once", async () => {
    const svc = await orders();
    const id = await confirmedOrderAsA1();
    const stock = await onHand();
    await expectRefusedWithoutWrites(() =>
      svc.transitionLifecycleStatus(server(MEMBER_A1, ORG_B), id, "cancelled", "x", A1),
    );
    expect(await onHand()).toBe(stock); // no stock restored for B's attempt
    const done = await svc.transitionLifecycleStatus(
      server(MEMBER_A1, ORG_A),
      id,
      "cancelled",
      "x",
      A1,
    );
    expect(done.lifecycleStatus).toBe("cancelled");
    expect(await onHand()).toBe(stock + 2);
    expect((await auditRows(id)).filter((r) => r.action === "orders.cancel")).toEqual([
      { action: "orders.cancel", organization_id: ORG_A, actor_user_id: MEMBER_A1 },
    ]);
    // The same request replayed in A is terminal and releases nothing more.
    const replay = await refusal(
      svc.transitionLifecycleStatus(server(MEMBER_A1, ORG_A), id, "cancelled", "x", A1),
    );
    expect(replay.statusCode).toBe(409);
    expect(await onHand()).toBe(stock + 2);
  });

  it("member switch: refused while A2, even though A2 holds orders.cancel in the same org", async () => {
    const svc = await orders();
    const id = await confirmedOrderAsA1();
    const stock = await onHand();
    await expectRefusedWithoutWrites(() =>
      svc.transitionLifecycleStatus(server(MEMBER_A2, ORG_A), id, "cancelled", "x", A1),
    );
    await svc.transitionLifecycleStatus(server(MEMBER_A1, ORG_A), id, "cancelled", "x", A1);
    expect(await onHand()).toBe(stock + 2);
    const cancels = (await auditRows(id)).filter((r) => r.action === "orders.cancel");
    expect(cancels.map((r) => r.actor_user_id)).toEqual([MEMBER_A1]);
  });
});

describe("A → B → A: courier handoff and delivery completion", () => {
  it("handoff refused while B; back in A it proceeds; then cancellation is refused by custody", async () => {
    const delivery = await deliveries();
    const svc = await orders();
    const id = await confirmedOrderAsA1();
    const d = await deliveryAsA1(id, "ready");
    const stock = await onHand();
    await expectRefusedWithoutWrites(() =>
      delivery.markDeliveryInTransit(server(MEMBER_B1, ORG_B), d, null, A1),
    );
    await expectRefusedWithoutWrites(() =>
      delivery.markDeliveryInTransit(server(MEMBER_A2, ORG_A), d, null, A1),
    );
    const moved = await delivery.markDeliveryInTransit(server(MEMBER_A1, ORG_A), d, null, A1);
    expect(moved.status).toBe("in_transit");

    const before = await writeSurface();
    const blocked = await refusal(
      svc.transitionLifecycleStatus(server(MEMBER_A1, ORG_A), id, "cancelled", "x", A1),
    );
    expect(blocked.statusCode).toBe(409);
    expect(blocked.code).toBe("order_cancel_goods_dispatched");
    expect(await writeSurface()).toEqual(before);
    expect(await onHand()).toBe(stock);
  });

  it("completion refused while B; back in A it completes; cancellation then refused: goods_with_customer", async () => {
    const delivery = await deliveries();
    const svc = await orders();
    const id = await confirmedOrderAsA1();
    const d = await deliveryAsA1(id, "in_transit");
    const stock = await onHand();
    await expectRefusedWithoutWrites(() =>
      delivery.markDeliveryDelivered(server(MEMBER_A1, ORG_B), d, null, A1),
    );
    expect(
      (await delivery.markDeliveryDelivered(server(MEMBER_A1, ORG_A), d, null, A1)).status,
    ).toBe("delivered");
    const before = await writeSurface();
    const blocked = await refusal(
      svc.transitionLifecycleStatus(server(MEMBER_A1, ORG_A), id, "cancelled", "x", A1),
    );
    expect(blocked.code).toBe("order_cancel_goods_with_customer");
    expect(await writeSurface()).toEqual(before);
    expect(await onHand()).toBe(stock); // the customer holds the goods: never restocked
  });
});

describe("A → B → A: counter handoff", () => {
  it("refused while B; back in A it fulfils once; cancellation then refused", async () => {
    const svc = await orders();
    const id = await confirmedOrderAsA1();
    const stock = await onHand();
    await expectRefusedWithoutWrites(() =>
      svc.transitionFulfillmentStatus(server(MEMBER_B1, ORG_B), id, "fulfilled", null, A1),
    );
    const done = await svc.transitionFulfillmentStatus(
      server(MEMBER_A1, ORG_A),
      id,
      "fulfilled",
      null,
      A1,
    );
    expect(done.fulfillmentStatus).toBe("fulfilled");
    const blocked = await refusal(
      svc.transitionLifecycleStatus(server(MEMBER_A1, ORG_A), id, "cancelled", "x", A1),
    );
    expect(blocked.code).toBe("order_cancel_goods_with_customer");
    expect(await onHand()).toBe(stock);
  });
});

describe("A → B → A: order creation replay", () => {
  it("refused while B (no order, no token); back in A one order; the retry replays it", async () => {
    const svc = await orders();
    const key = `harness_${crypto.randomUUID().replaceAll("-", "")}`;
    const input = {
      source: "POS",
      items: [{ variantId: VARIANT, quantity: 1 }],
      locationId: LOCATION,
      idempotencyKey: key,
      expectedPrincipal: A1,
    } as Parameters<typeof svc.createOrder>[1];
    await expectRefusedWithoutWrites(() => svc.createOrder(server(MEMBER_A1, ORG_B), input));
    await expectRefusedWithoutWrites(() => svc.createOrder(server(MEMBER_B1, ORG_B), input));
    const first = await svc.createOrder(server(MEMBER_A1, ORG_A), input);
    const again = await svc.createOrder(server(MEMBER_A1, ORG_A), input);
    expect(again.id).toBe(first.id);
    const [r] = await sql`select count(*)::int as n, min(created_by::text) as by,
        min(organization_id::text) as org from orders where idempotency_key = ${key}`;
    expect(plain(r)).toEqual({ n: 1, by: MEMBER_A1, org: ORG_A });
  });
});

describe("tenant isolation and fail-closed principal", () => {
  it("an honest principal of B naming A's order id (IDOR) gets 404 and writes nothing", async () => {
    const svc = await orders();
    const delivery = await deliveries();
    const id = await confirmedOrderAsA1();
    const d = await deliveryAsA1(id, "ready");
    const B1: Principal = { userId: MEMBER_B1, organizationId: ORG_B };
    const before = await writeSurface();
    for (const attempt of [
      () => svc.transitionLifecycleStatus(server(MEMBER_B1, ORG_B), id, "cancelled", "x", B1),
      () => svc.transitionFulfillmentStatus(server(MEMBER_B1, ORG_B), id, "fulfilled", null, B1),
      () => delivery.markDeliveryInTransit(server(MEMBER_B1, ORG_B), d, null, B1),
      () => delivery.cancelDelivery(server(MEMBER_B1, ORG_B), d, "x", B1),
    ]) {
      expect((await refusal(attempt())).statusCode).toBe(404);
    }
    expect(await writeSurface()).toEqual(before);
  });

  it("a request without a principal is refused 428 before anything is read or written", async () => {
    const svc = await orders();
    const id = await confirmedOrderAsA1();
    const before = await writeSurface();
    const error = await refusal(
      svc.transitionLifecycleStatus(
        server(MEMBER_A1, ORG_A),
        id,
        "cancelled",
        "x",
        undefined as unknown as Principal,
      ),
    );
    expect(error.statusCode).toBe(428);
    expect(error.code).toBe("principal_required");
    expect(await writeSurface()).toEqual(before);
  });

  it("a principal mismatch is refused before the permission check (no permission oracle)", async () => {
    const svc = await orders();
    const id = await confirmedOrderAsA1();
    const error = await refusal(
      svc.transitionLifecycleStatus(server(MEMBER_A2, ORG_A, []), id, "cancelled", "x", A1),
    );
    expect(error.code).toBe("principal_changed");
  });
});
