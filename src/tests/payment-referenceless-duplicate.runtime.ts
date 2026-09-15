import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { financialFixture } from "./helpers/payment-order-fixture";

// Migration 043 — reference-less duplicate-payment suspicion.
//
// PRE-FIX / POST-FIX PROOF (see migration 043's header for the full defect):
// before this migration, two reference-less cash payments for the same
// 10000 Order with different idempotency keys (A: lost-response retry, B:
// the retry itself) both record as ordinary 'unverified' rows. If both are
// later verified, order_payment_totals sums both principals: received_minor
// becomes 20000 against a 10000 Order — invented money. This file proves
// both the pre-043 defect (skipAuthority, migration 043 excluded) and the
// post-043 fix (the default fixture, which includes 043) from the same
// scenario, then exercises the reference-less duplicate algorithm itself.

const migrationSql = () =>
  readFileSync("supabase/migrations/043_payment_referenceless_duplicate.sql", "utf8");

const referencelessBlock = () => {
  const sql = migrationSql();
  const start = sql.indexOf("REFERENCELESS_DUPLICATE_CHECK_START");
  const end = sql.indexOf("REFERENCELESS_DUPLICATE_CHECK_END");
  if (start === -1 || end === -1)
    throw new Error("referenceless duplicate check markers not found");
  return sql.slice(start, end);
};

async function recordRaw(
  f: Awaited<ReturnType<typeof financialFixture>>,
  org: string,
  order: string,
  method: string,
  amount: number,
  reference: string | null,
  key: string | null,
) {
  return f.rpc("record_payment_v1", [
    org,
    order,
    f.actor,
    method,
    amount,
    reference,
    key,
    null,
  ]) as Promise<{
    status: string;
    payment_id?: string;
    duplicate_suspected?: boolean;
    replayed?: boolean;
  }>;
}

describe("PRE-FIX / POST-FIX proof", () => {
  it("BEFORE 043 (migration 043 excluded from the schema): two reference-less retries both verify and double-count received_minor", async () => {
    // Real proof, not a simulation: the fixture applies every migration
    // 001-042 (including 040, so record_payment_v1 / Order locking /
    // idempotency conflict handling are all present exactly as shipped) but
    // skips 043 — so record_payment_before_order_v1 here is genuinely the
    // pre-043 body, with only the reference-based duplicate check.
    const f = await financialFixture(false, true);
    try {
      const first = await recordRaw(f, f.org, f.order, "cash", 10000, null, "pre-fix-a");
      const second = await recordRaw(f, f.org, f.order, "cash", 10000, null, "pre-fix-b");
      // Pre-043: no reference-less signal exists at all, regardless of timing.
      expect(first.duplicate_suspected).toBe(false);
      expect(second.duplicate_suspected).toBe(false);
      expect(
        (
          await f.db.query(
            "select verification_state from payments where order_id=$1 order by created_at",
            [f.order],
          )
        ).rows,
      ).toEqual([{ verification_state: "unverified" }, { verification_state: "unverified" }]);
      await f.verify(first.payment_id!);
      await f.verify(second.payment_id!);
      // The proven defect: invented money. 20000 received against a 10000 Order.
      expect(await f.state()).toMatchObject({ payment_status: "paid", received_minor: 20000 });
    } finally {
      await f.close();
    }
  });

  it("AFTER 043: the same lost-response retry sequence, within the window, flags the second row and protects settled truth", async () => {
    const f = await financialFixture();
    try {
      const first = await recordRaw(f, f.org, f.order, "cash", 10000, null, "post-fix-a");
      expect(first.duplicate_suspected).toBe(false);
      const second = await recordRaw(f, f.org, f.order, "cash", 10000, null, "post-fix-b");
      expect(second.status).toBe("success");
      expect(second.duplicate_suspected).toBe(true);
      expect(
        (
          await f.db.query("select verification_state from payments where id=$1", [
            second.payment_id,
          ])
        ).rows[0]!.verification_state,
      ).toBe("duplicate_suspected");
      // Settled financial truth is protected until explicit reconciliation:
      // the flagged row is still 'pending', not 'paid', and the first row is
      // untouched.
      expect(await f.state()).toMatchObject({ payment_status: "pending", received_minor: 0 });
      const firstAfter = (
        await f.db.query("select * from payments where id=$1", [first.payment_id])
      ).rows[0];
      expect(firstAfter.verification_state).toBe("unverified");
    } finally {
      await f.close();
    }
  });
});

describe("Migration 043 — reference-less duplicate algorithm", () => {
  it("A. same Order/method/amount with different idempotency keys: second is duplicate_suspected", async () => {
    const f = await financialFixture();
    try {
      const first = await recordRaw(f, f.org, f.order, "cash", 10000, null, "key-a");
      const second = await recordRaw(f, f.org, f.order, "cash", 10000, null, "key-b");
      expect(second.status).toBe("success");
      expect(second.duplicate_suspected).toBe(true);
      const rows = (
        await f.db.query(
          "select id,verification_state from payments where order_id=$1 order by created_at",
          [f.order],
        )
      ).rows;
      expect(rows).toEqual([
        { id: first.payment_id, verification_state: "unverified" },
        { id: second.payment_id, verification_state: "duplicate_suspected" },
      ]);
    } finally {
      await f.close();
    }
  });

  it("B. same idempotency key replays the same payment — no duplicate row is created", async () => {
    const f = await financialFixture();
    try {
      const a = await recordRaw(f, f.org, f.order, "cash", 10000, null, "same-key");
      const b = await recordRaw(f, f.org, f.order, "cash", 10000, null, "same-key");
      expect(b.payment_id).toBe(a.payment_id);
      expect(b.replayed).toBe(true);
      expect(
        (await f.db.query("select count(*)::int as n from payments where order_id=$1", [f.order]))
          .rows[0]!.n,
      ).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("C. a legitimate equal-amount split payment is still recordable, may be duplicate_suspected, and is never rejected", async () => {
    const f = await financialFixture();
    try {
      const order = await f.newOrder(f.org, 20000);
      const a = await recordRaw(f, f.org, order, "cash", 10000, null, "split-a");
      const b = await recordRaw(f, f.org, order, "cash", 10000, null, "split-b");
      expect(a.status).toBe("success");
      expect(b.status).toBe("success");
      expect(b.duplicate_suspected).toBe(true);
      await f.verify(a.payment_id!);
      // b started life as 'duplicate_suspected', not 'unverified' — the
      // reviewer verifies it from its actual state, same as any other
      // verification_state.
      await f.verify(b.payment_id!, "staff_confirmed", "duplicate_suspected");
      expect(await f.state(order)).toMatchObject({ payment_status: "paid", received_minor: 20000 });
    } finally {
      await f.close();
    }
  });

  it("D. a different amount is not flagged", async () => {
    const f = await financialFixture();
    try {
      await recordRaw(f, f.org, f.order, "cash", 10000, null, "amt-a");
      const second = await recordRaw(f, f.org, f.order, "cash", 9000, null, "amt-b");
      expect(second.duplicate_suspected).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("E. a different method is not flagged", async () => {
    const f = await financialFixture();
    try {
      await recordRaw(f, f.org, f.order, "cash", 10000, null, "meth-a");
      const second = await recordRaw(f, f.org, f.order, "bank_transfer", 10000, null, "meth-b");
      expect(second.duplicate_suspected).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("F. a different Order is not flagged", async () => {
    const f = await financialFixture();
    try {
      await recordRaw(f, f.org, f.order, "cash", 10000, null, "ord-a");
      const other = await f.newOrder();
      const second = await recordRaw(f, f.org, other, "cash", 10000, null, "ord-b");
      expect(second.duplicate_suspected).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("G. a different organization is isolated (behavioral, complements the structural org-predicate assertion below)", async () => {
    const f = await financialFixture();
    try {
      await recordRaw(f, f.org, f.order, "cash", 10000, null, "org-a");
      const orderB = await f.newOrder(f.orgB);
      const second = await recordRaw(f, f.orgB, orderB, "cash", 10000, null, "org-b");
      expect(second.duplicate_suspected).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("H. a previously reversed Payment is excluded from suspicion", async () => {
    const f = await financialFixture();
    try {
      const first = await recordRaw(f, f.org, f.order, "cash", 10000, null, "rev-a");
      await f.reverse(first.payment_id!);
      const second = await recordRaw(f, f.org, f.order, "cash", 10000, null, "rev-b");
      expect(second.duplicate_suspected).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("I. queued identical reference-less requests still serialize to exactly one flagged row of two", async () => {
    const f = await financialFixture();
    try {
      const order = await f.newOrder();
      const [a, b] = await Promise.all([
        recordRaw(f, f.org, order, "cash", 10000, null, "race-a"),
        recordRaw(f, f.org, order, "cash", 10000, null, "race-b"),
      ]);
      expect([a.status, b.status]).toEqual(["success", "success"]);
      expect([a.duplicate_suspected, b.duplicate_suspected].sort()).toEqual([false, true]);
      expect(
        (await f.db.query("select count(*)::int as n from payments where order_id=$1", [order]))
          .rows[0]!.n,
      ).toBe(2);
    } finally {
      await f.close();
    }
  });

  it("J. provider-reference duplicate semantics are unchanged by 043", async () => {
    const f = await financialFixture();
    try {
      const first = await recordRaw(f, f.org, f.order, "khqr", 10000, "TXN-1", null);
      const second = await recordRaw(f, f.org, f.order, "khqr", 5000, "TXN-1", null);
      expect(first.duplicate_suspected).toBe(false);
      expect(second.duplicate_suspected).toBe(true);
      expect(
        (
          await f.db.query(
            "select metadata from payment_events where payment_id=$1 and event_type='duplicate_flagged'",
            [second.payment_id],
          )
        ).rows[0]!.metadata,
      ).toMatchObject({ kind: "reference" });
    } finally {
      await f.close();
    }
  });

  it("J2. two genuinely different provider references never collide (live behavioral proof, not just static text)", async () => {
    // The repository's existing "duplicate-reference check is organization-
    // scoped" coverage (payment-domain.runtime.ts Test 4) reads the SQL text
    // of migration 035 directly — the pre-043 source, never the function
    // CREATE OR REPLACEd by 043. It cannot see a regression 043 introduces
    // into the live reference branch. This test calls the real RPC through
    // PGlite against the fully-migrated (043-included) schema, so a mutation
    // that drops the `reference = v_reference` predicate — which would make
    // any other active payment in the organization look like a reference
    // collision — is caught here.
    const f = await financialFixture();
    try {
      const first = await recordRaw(f, f.org, f.order, "khqr", 10000, "TXN-A", null);
      const second = await recordRaw(f, f.org, f.order, "khqr", 10000, "TXN-B", null);
      expect(first.duplicate_suspected).toBe(false);
      expect(second.duplicate_suspected).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("K. a payment created just outside the 10-minute window is not flagged", async () => {
    const f = await financialFixture();
    try {
      const first = await recordRaw(f, f.org, f.order, "cash", 10000, null, "win-a");
      await f.db.query(
        "update payments set created_at = now() - interval '11 minutes' where id=$1",
        [first.payment_id],
      );
      const second = await recordRaw(f, f.org, f.order, "cash", 10000, null, "win-b");
      expect(second.duplicate_suspected).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("K. a payment created just inside the 10-minute window is flagged", async () => {
    const f = await financialFixture();
    try {
      const first = await recordRaw(f, f.org, f.order, "cash", 10000, null, "win2-a");
      await f.db.query(
        "update payments set created_at = now() - interval '9 minutes' where id=$1",
        [first.payment_id],
      );
      const second = await recordRaw(f, f.org, f.order, "cash", 10000, null, "win2-b");
      expect(second.duplicate_suspected).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("duplicate_suspected is never auto-verified: status stays pending until a human verifies", async () => {
    const f = await financialFixture();
    try {
      await recordRaw(f, f.org, f.order, "cash", 10000, null, "auto-a");
      const second = await recordRaw(f, f.org, f.order, "cash", 10000, null, "auto-b");
      expect(
        (
          await f.db.query("select status,verification_state from payments where id=$1", [
            second.payment_id,
          ])
        ).rows[0],
      ).toEqual({ status: "pending", verification_state: "duplicate_suspected" });
    } finally {
      await f.close();
    }
  });

  it("a duplicate_suspected payment can still be explicitly verified through the normal state machine", async () => {
    const f = await financialFixture();
    try {
      // Order total exceeds either single payment, so verifying only the
      // flagged one leaves the order still 'pending' — this isolates the
      // assertion to "verification succeeded", not "the order settled".
      const order = await f.newOrder(f.org, 20000);
      await recordRaw(f, f.org, order, "cash", 10000, null, "verify-a");
      const second = await recordRaw(f, f.org, order, "cash", 10000, null, "verify-b");
      const verified = await f.rpc("verify_payment_v1", [
        f.org,
        second.payment_id,
        f.actor,
        "duplicate_suspected",
        "staff_confirmed",
        "reviewed",
        null,
      ]);
      expect(verified.status).toBe("success");
      expect(
        (
          await f.db.query("select status,verification_state from payments where id=$1", [
            second.payment_id,
          ])
        ).rows[0],
      ).toEqual({ status: "paid", verification_state: "staff_confirmed" });
      expect((await f.state(order)).payment_status).toBe("pending");
    } finally {
      await f.close();
    }
  });

  it("recording a suspected duplicate never rejects it and never mutates the earlier Payment", async () => {
    const f = await financialFixture();
    try {
      const first = await recordRaw(f, f.org, f.order, "cash", 10000, null, "keep-a");
      const before = (await f.db.query("select * from payments where id=$1", [first.payment_id]))
        .rows[0];
      const second = await recordRaw(f, f.org, f.order, "cash", 10000, null, "keep-b");
      expect(second.status).toBe("success");
      const after = (await f.db.query("select * from payments where id=$1", [first.payment_id]))
        .rows[0];
      expect(after).toEqual(before);
    } finally {
      await f.close();
    }
  });

  it("cross-tenant reference-less isolation also holds at the RPC boundary (not_found, no leak)", async () => {
    const f = await financialFixture();
    try {
      const orderB = await f.newOrder(f.orgB);
      const foreign = await recordRaw(f, f.orgB, orderB, "cash", 10000, null, "cross-a");
      expect(foreign.status).toBe("success");
      // f.org cannot even see orderB to attempt a same-shape request against it.
      const attempt = await f.rpc("record_payment_v1", [
        f.org,
        orderB,
        f.actor,
        "cash",
        10000,
        null,
        "cross-b",
        null,
      ]);
      expect(attempt.status).toBe("not_found");
    } finally {
      await f.close();
    }
  });
});

describe("Defence-in-depth — structural assertions on migration 043's SQL text", () => {
  it("modifies record_payment_before_order_v1, never the public wrapper record_payment_v1", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.record_payment_before_order_v1/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.record_payment_v1\s*\(/);
  });

  it("the reference-less branch explicitly predicates on organization_id, order_id, method and amount_minor", () => {
    // Behavior-only tests (D/E/F/G above) cannot by themselves prove the
    // organization_id predicate survives, because order_id already isolates
    // tenants (orders are never shared across organizations) — a mutation
    // that dropped `AND organization_id = p_organization_id` would still
    // pass every behavioral cross-tenant test. This structural assertion on
    // the function's own SQL text is the defence-in-depth check for exactly
    // that mutation, mirroring the equivalent assertion this repository
    // already carries for other financial predicates.
    const block = referencelessBlock();
    expect(block).toContain("WHERE organization_id = p_organization_id");
    expect(block).toContain("AND order_id = p_order_id");
    expect(block).toContain("AND method = p_method::public.payment_method");
    expect(block).toContain("AND amount_minor = p_amount_minor");
    expect(block).toContain("AND reference IS NULL");
    expect(block).toContain("AND status <> 'reversed'");
    expect(block).toContain("interval '10 minutes'");
  });

  it("the reference-less branch takes a transaction-scoped advisory lock before the duplicate check", () => {
    const block = referencelessBlock();
    const lockIndex = block.indexOf("pg_advisory_xact_lock");
    const checkIndex = block.indexOf("SELECT EXISTS");
    expect(lockIndex).toBeGreaterThan(-1);
    expect(checkIndex).toBeGreaterThan(lockIndex);
  });

  it("record_payment_before_order_v1 stays revoked from every role in this file", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_payment_before_order_v1\([^)]*\)\s*\n\s*FROM PUBLIC, anon, authenticated, service_role/,
    );
  });
});
