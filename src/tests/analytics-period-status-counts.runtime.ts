/**
 * Migration 049 executed against the REAL migrated schema (all migrations, in
 * order, through PGlite). Spawned by analytics-period-status-counts-sql.test.ts.
 *
 * The function under test is the one created by the committed file
 * supabase/migrations/049_analytics_period_status_counts.sql — applied by the
 * fixture with every other migration, then re-applied verbatim here. Nothing
 * about its SQL is re-implemented in this file.
 *
 * Proves:
 *   - 049 applies, and re-applies cleanly;
 *   - created_at lower bound is inclusive, upper bound is exclusive;
 *   - every order status axis (lifecycle / payment / fulfillment / refund) and
 *     the payment method axis group correctly;
 *   - organizations are isolated on BOTH the orders and the payments side;
 *   - an empty range and an unknown organization return no rows;
 *   - anon and authenticated cannot execute it; service_role can.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { financialFixture } from "./helpers/payment-order-fixture";

const MIGRATION_049 = readFileSync(
  "supabase/migrations/049_analytics_period_status_counts.sql",
  "utf8",
);
const FN = "public.analytics_period_status_counts_v1";
const SIGNATURE = `${FN}(uuid, timestamptz, timestamptz)`;

const FROM = "2026-09-10T17:00:00.000Z";
const UNTIL = "2026-09-11T17:00:00.000Z";
const UNKNOWN_ORG = "cccccccc-0000-4000-8000-000000000001";

let fixture: Awaited<ReturnType<typeof financialFixture>>;
let db: PGlite;

type Group = { axis: string; value: string; row_count: number };

async function counts(org: string, from = FROM, until = UNTIL): Promise<Group[]> {
  const result = await db.query<{ axis: string; value: string; row_count: string | number }>(
    `select axis, value, row_count from ${FN}(
       p_organization_id => $1, p_from => $2, p_until => $3)`,
    [org, from, until],
  );
  return result.rows
    .map((r) => ({ axis: r.axis, value: r.value, row_count: Number(r.row_count) }))
    .sort((a, b) => `${a.axis}:${a.value}`.localeCompare(`${b.axis}:${b.value}`));
}

function grouped(rows: Group[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.axis] ??= {})[r.value] = r.row_count;
  return out;
}

async function asRole<T>(role: string, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec("RESET ROLE");
  }
}

beforeAll(async () => {
  fixture = await financialFixture();
  db = fixture.db;
  const { org, orgB, actor } = fixture;

  // Seed rows in exact states and at exact timestamps. Order payment/refund
  // status is normally writable only through the Payment domain (040's
  // triggers), which is not what this file tests — so seeding (and only
  // seeding) bypasses row triggers. The function under test runs normally.
  await db.exec("SET session_replication_role = replica");
  let n = 0;
  async function order(
    tenant: string,
    createdAt: string,
    s: { l?: string; p?: string; f?: string; r?: string } = {},
  ) {
    const id = crypto.randomUUID();
    n += 1;
    await db.query(
      `insert into orders(id, organization_id, order_number, source, currency,
         subtotal_minor, total_minor, created_by, created_at,
         lifecycle_status, payment_status, fulfillment_status, refund_status)
       values ($1, $2, $3, 'MANUAL', 'USD', 1000, 1000, $4, $5,
         $6::order_lifecycle_status, $7::order_payment_status,
         $8::order_fulfillment_status, $9::order_refund_status)`,
      [
        id,
        tenant,
        `SEED-${n}`,
        actor,
        createdAt,
        s.l ?? "confirmed",
        s.p ?? "unpaid",
        s.f ?? "unfulfilled",
        s.r ?? "none",
      ],
    );
    return id;
  }
  async function payment(tenant: string, orderId: string, createdAt: string, method: string) {
    await db.query(
      `insert into payments(organization_id, order_id, method, currency, amount_minor, created_at)
       values ($1, $2, $3::payment_method, 'USD', 100, $4)`,
      [tenant, orderId, method, createdAt],
    );
  }

  // Org A, in period.
  const a1 = await order(org, FROM); // exactly the lower bound: IN
  await order(org, "2026-09-11T02:00:00.000Z", { p: "paid", f: "fulfilled" });
  await order(org, "2026-09-11T03:00:00.000Z", { l: "completed", p: "paid", r: "partial" });
  await order(org, "2026-09-11T04:00:00.000Z", { l: "cancelled", f: "cancelled", r: "full" });
  await order(org, "2026-09-11T05:00:00.000Z", { l: "draft", p: "pending", f: "processing" });
  await order(org, "2026-09-11T06:00:00.000Z", { p: "failed" });
  // Org A, out of period.
  await order(org, UNTIL, { l: "completed", p: "paid" }); // exactly the upper bound: OUT
  await order(org, "2026-09-10T16:59:59.999Z", { l: "cancelled" }); // just before: OUT
  // Org B, in period — must never appear in Org A's counts.
  const b1 = await order(orgB, "2026-09-11T02:00:00.000Z", {
    l: "completed",
    p: "paid",
    f: "fulfilled",
    r: "full",
  });

  await payment(org, a1, FROM, "cash"); // lower bound: IN
  await payment(org, a1, "2026-09-11T03:00:00.000Z", "khqr");
  await payment(org, a1, "2026-09-11T03:30:00.000Z", "khqr");
  await payment(org, a1, "2026-09-11T04:00:00.000Z", "cod");
  await payment(org, a1, UNTIL, "bank_transfer"); // upper bound: OUT
  await payment(org, a1, "2026-09-10T16:59:59.999Z", "cod"); // just before: OUT
  await payment(orgB, b1, "2026-09-11T02:00:00.000Z", "bank_transfer");
  await payment(orgB, b1, "2026-09-11T02:30:00.000Z", "bank_transfer");
  await db.exec("SET session_replication_role = origin");
});

afterAll(async () => {
  await fixture.close();
});

describe("migration 049 — applies from the committed file", () => {
  it("is present after every migration was applied in order", async () => {
    const result = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc
       where oid = to_regprocedure('${SIGNATURE}')`,
    );
    expect(result.rows[0]!.n).toBe(1);
  });

  it("re-applies cleanly, with identical results", async () => {
    const before = await counts(fixture.org);
    await db.exec(MIGRATION_049);
    await db.exec(MIGRATION_049);
    expect(await counts(fixture.org)).toEqual(before);
  });
});

describe("migration 049 — exact counts", () => {
  it("groups every order status axis and payment methods for the organization and period", async () => {
    expect(grouped(await counts(fixture.org))).toEqual({
      lifecycle_status: { confirmed: 3, completed: 1, cancelled: 1, draft: 1 },
      payment_status: { unpaid: 2, paid: 2, pending: 1, failed: 1 },
      fulfillment_status: { unfulfilled: 3, fulfilled: 1, cancelled: 1, processing: 1 },
      refund_status: { none: 4, partial: 1, full: 1 },
      payment_method: { cash: 1, khqr: 2, cod: 1 },
    });
  });

  it("each order axis sums to the number of orders in the period", async () => {
    const g = grouped(await counts(fixture.org));
    for (const axis of [
      "lifecycle_status",
      "payment_status",
      "fulfillment_status",
      "refund_status",
    ]) {
      expect(Object.values(g[axis]!).reduce((a, b) => a + b, 0)).toBe(6);
    }
  });

  it("the lower bound is inclusive", async () => {
    // A window of exactly one microsecond starting at FROM holds only the
    // order and the payment created at FROM.
    const g = grouped(await counts(fixture.org, FROM, "2026-09-10T17:00:00.000001Z"));
    expect(g.lifecycle_status).toEqual({ confirmed: 1 });
    expect(g.payment_method).toEqual({ cash: 1 });
  });

  it("the upper bound is exclusive", async () => {
    // [UNTIL, UNTIL + 1µs) holds exactly the rows created at UNTIL…
    const at = grouped(await counts(fixture.org, UNTIL, "2026-09-11T17:00:00.000001Z"));
    expect(at.lifecycle_status).toEqual({ completed: 1 });
    expect(at.payment_method).toEqual({ bank_transfer: 1 });
    // …and they are absent from the period that ends at UNTIL.
    const g = grouped(await counts(fixture.org));
    expect(g.payment_method!.bank_transfer).toBeUndefined();
    expect(g.lifecycle_status!.completed).toBe(1);
  });

  it("keeps organizations isolated on both the orders and the payments side", async () => {
    expect(grouped(await counts(fixture.orgB))).toEqual({
      lifecycle_status: { completed: 1 },
      payment_status: { paid: 1 },
      fulfillment_status: { fulfilled: 1 },
      refund_status: { full: 1 },
      payment_method: { bank_transfer: 2 },
    });
  });

  it("an empty range returns no rows", async () => {
    expect(await counts(fixture.org, FROM, FROM)).toEqual([]);
    expect(await counts(fixture.org, "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z")).toEqual([]);
  });

  it("an unknown organization returns no rows", async () => {
    expect(await counts(UNKNOWN_ORG)).toEqual([]);
    expect(await counts(UNKNOWN_ORG, "1970-01-01T00:00:00Z", "2100-01-01T00:00:00Z")).toEqual([]);
  });
});

describe("migration 049 — EXECUTE is service_role only", () => {
  const denied = /permission denied for function analytics_period_status_counts_v1/;

  for (const role of ["anon", "authenticated"]) {
    it(`${role} cannot execute it`, async () => {
      const privilege = await db.query<{ ok: boolean }>(
        `select has_function_privilege($1, '${SIGNATURE}', 'EXECUTE') as ok`,
        [role],
      );
      expect(privilege.rows[0]!.ok).toBe(false);
      let error: unknown = null;
      await asRole(role, async () => {
        try {
          await counts(fixture.org);
        } catch (e) {
          error = e;
        }
      });
      expect((error as { code?: string } | null)?.code).toBe("42501");
      expect(String((error as Error).message)).toMatch(denied);
    });
  }

  it("PUBLIC holds no EXECUTE grant", async () => {
    const result = await db.query<{ n: number }>(
      `select count(*)::int as n
       from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = to_regprocedure('${SIGNATURE}') and a.grantee = 0
         and a.privilege_type = 'EXECUTE'`,
    );
    expect(result.rows[0]!.n).toBe(0);
  });

  it("service_role can execute it and gets the same counts", async () => {
    const asSuper = await counts(fixture.org);
    const asService = await asRole("service_role", () => counts(fixture.org));
    expect(asService).toEqual(asSuper);
    expect(asService.length).toBeGreaterThan(0);
  });
});
