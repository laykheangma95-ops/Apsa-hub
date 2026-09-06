import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { financialFixture } from "./helpers/payment-order-fixture";

describe("approved canonical refund semantics", () => {
  it("a $20 refund of a paid $100 order preserves paid and records partial", async () => {
    const f = await financialFixture();
    try {
      const payment = await f.record(10000);
      await f.verify(payment);
      await f.refund(payment, 2000);
      expect(await f.state()).toMatchObject({
        payment_status: "paid",
        refund_status: "partial",
        refunded_minor: 2000,
        net_minor: 8000,
      });
    } finally {
      await f.close();
    }
  });

  it("a full $100 refund preserves paid and records full without rewriting principal", async () => {
    const f = await financialFixture();
    try {
      const payment = await f.record(10000);
      await f.verify(payment);
      await f.refund(payment, 10000);
      expect(await f.state()).toMatchObject({
        payment_status: "paid",
        refund_status: "full",
        refunded_minor: 10000,
        net_minor: 0,
      });
      expect(
        (await f.db.query("select amount_minor from payments where id=$1", [payment])).rows,
      ).toEqual([{ amount_minor: 10000 }]);
    } finally {
      await f.close();
    }
  });
});

describe("Payment transaction authority and isolation", () => {
  let f: Awaited<ReturnType<typeof financialFixture>>;
  beforeAll(async () => {
    f = await financialFixture();
  }, 15000);
  afterAll(async () => {
    await f.close();
  });

  it("recording and evidence cannot establish paid; staff, manager and bank verification can", async () => {
    for (const tier of ["staff_confirmed", "manager_verified", "bank_verified"]) {
      const order = await f.newOrder();
      const payment = await f.record(10000, "cash", null, order);
      expect((await f.state(order)).payment_status).toBe("pending");
      await f.rpc("attach_payment_evidence_v1", [
        f.org,
        payment,
        f.actor,
        "receipt",
        "test/receipt",
        null,
        null,
      ]);
      expect((await f.state(order)).payment_status).toBe("pending");
      if (tier === "manager_verified") await f.verify(payment);
      expect(
        (
          await f.verify(
            payment,
            tier,
            tier === "manager_verified" ? "staff_confirmed" : "unverified",
          )
        ).status,
      ).toBe("success");
      expect((await f.state(order)).payment_status).toBe("paid");
    }
  });

  it("failed verification does not pay the order and an invalid DB verification transition is rejected", async () => {
    const order = await f.newOrder();
    const payment = await f.record(10000, "cash", null, order);
    expect((await f.verify(payment, "manager_verified")).status).toBe("invalid_transition");
    await f.verify(payment, "mismatch");
    expect((await f.state(order)).payment_status).toBe("failed");
  });

  it("split payments aggregate and reversing $60 of $60+$40 removes full payment", async () => {
    const order = await f.newOrder();
    const a = await f.record(6000, "cash", null, order);
    const b = await f.record(4000, "bank_transfer", null, order);
    await f.verify(a);
    expect((await f.state(order)).payment_status).toBe("pending");
    await f.verify(b, "bank_verified");
    expect((await f.state(order)).payment_status).toBe("paid");
    await f.reverse(a);
    expect(await f.state(order)).toMatchObject({
      payment_status: "pending",
      received_minor: 4000,
      net_minor: 4000,
    });
  });

  it("refunding one split payment preserves paid and is only a partial Order refund", async () => {
    const order = await f.newOrder();
    const a = await f.record(6000, "cash", null, order);
    const b = await f.record(4000, "cash", null, order);
    await f.verify(a);
    await f.verify(b);
    await f.refund(a, 6000);
    expect(await f.state(order)).toMatchObject({
      payment_status: "paid",
      refund_status: "partial",
      net_minor: 4000,
    });
    await f.refund(b, 4000);
    expect(await f.state(order)).toMatchObject({
      payment_status: "paid",
      refund_status: "full",
      net_minor: 0,
    });
  });

  it("reversal after partial refund invalidates only the unrefunded settlement", async () => {
    const order = await f.newOrder();
    const payment = await f.record(10000, "cash", null, order);
    await f.verify(payment);
    await f.refund(payment, 2000);
    await f.reverse(payment);
    expect(await f.state(order)).toMatchObject({
      payment_status: "pending",
      refunded_minor: 2000,
      net_minor: 0,
    });
  });

  it("overpayments and refunded partial receipts do not misclassify an Order", async () => {
    const order = await f.newOrder();
    const payment = await f.record(15000, "cash", null, order);
    await f.verify(payment);
    await f.refund(payment, 10000);
    expect(await f.state(order)).toMatchObject({
      payment_status: "paid",
      refund_status: "partial",
      net_minor: 5000,
    });
    const underpaid = await f.newOrder();
    const partial = await f.record(4000, "cash", null, underpaid);
    await f.verify(partial);
    await f.refund(partial, 4000);
    expect(await f.state(underpaid)).toMatchObject({
      payment_status: "pending",
      refund_status: "full",
      net_minor: 0,
    });
  });

  it("a delivery/fulfillment fact cannot pay an Order; actual COD settlement does", async () => {
    const order = await f.newOrder();
    await f.db.query(
      `insert into deliveries(organization_id,order_id,provider_name,
      cod_amount_minor,cod_currency,status) values($1,$2,'Manual COD',10000,'USD','delivered')`,
      [f.org, order],
    );
    expect((await f.state(order)).payment_status).toBe("unpaid");
    await f.rpc("transition_order_status_v1", [
      f.org,
      order,
      "fulfillment",
      "unfulfilled",
      "fulfilled",
      f.actor,
      "COD delivered",
    ]);
    expect((await f.state(order)).payment_status).toBe("unpaid");
    const payment = await f.record(10000, "cod", null, order);
    expect((await f.state(order)).payment_status).toBe("pending");
    await f.verify(payment);
    expect((await f.state(order)).payment_status).toBe("paid");
  });

  it("Order confirmation and cancellation still consume and restore stock once", async () => {
    const product = (
      await f.db.query<{ id: string }>(
        "insert into products(organization_id,name_km,name_en) values($1,'សាកល្បង','Payment test') returning id",
        [f.org],
      )
    ).rows[0]!.id;
    const variant = (
      await f.db.query<{ id: string }>(
        "insert into product_variants(organization_id,product_id,name,price_amount) values($1,$2,'Unit',5000) returning id",
        [f.org, product],
      )
    ).rows[0]!.id;
    const result = await f.rpc("create_order_v1", [
      f.org,
      f.actor,
      "MANUAL",
      JSON.stringify([{ variant_id: variant, quantity: 2 }]),
      null,
      null,
      0,
      null,
    ]);
    expect(result.status).toBe("success");
    const order = result.order_id as string;
    const confirmed = await f.rpc("transition_order_status_v1", [
      f.org,
      order,
      "lifecycle",
      "draft",
      "confirmed",
      f.actor,
      "confirm",
    ]);
    expect(confirmed.status).toBe("success");
    expect(confirmed.stock_movements).toBe(1);
    const payment = await f.record(10000, "cash", null, order);
    await f.verify(payment);
    await f.refund(payment, 2000);
    const movements = await f.db.query(
      "select movement_type,quantity_delta from inventory_movements where variant_id=$1",
      [variant],
    );
    expect(movements.rows).toEqual([{ movement_type: "sale", quantity_delta: -2 }]);
    const cancelled = await f.rpc("transition_order_status_v1", [
      f.org,
      order,
      "lifecycle",
      "confirmed",
      "cancelled",
      f.actor,
      "cancel",
    ]);
    expect(cancelled.stock_movements).toBe(1);
    expect(
      (
        await f.db.query(
          "select sum(quantity_delta)::int as net from inventory_movements where variant_id=$1",
          [variant],
        )
      ).rows[0]!.net,
    ).toBe(0);
    // Financial corrections remain possible after operational completion.
    await f.refund(payment, 8000);
    expect(await f.state(order)).toMatchObject({ payment_status: "paid", refund_status: "full" });
  });

  it("duplicate and simultaneous queued confirmation requests never double count settlement", async () => {
    // PGlite has one connection: these verify replay/interleaving outcomes, not
    // independent PostgreSQL sessions contending for row locks.
    const order = await f.newOrder();
    const [a, b] = await Promise.all([
      f.record(10000, "cash", "same-action", order),
      f.record(10000, "cash", "same-action", order),
    ]);
    expect(a).toBe(b);
    const results = await Promise.all([f.verify(a), f.verify(a)]);
    expect(results.map((r) => r.status).sort()).toEqual(["stale", "success"]);
    expect(await f.state(order)).toMatchObject({ received_minor: 10000, payment_status: "paid" });
    expect(
      (
        await f.db.query(
          "select count(*)::int as n from payment_events where payment_id=$1 and event_type='staff_confirmed'",
          [a],
        )
      ).rows[0]!.n,
    ).toBe(1);
    const other = await f.newOrder();
    await expect(f.record(10000, "cash", "same-action", other)).rejects.toThrow(
      "idempotency key conflicts",
    );
  });

  it("separate queued payments and verification/refund/reversal preserve deterministic aggregates", async () => {
    const order = await f.newOrder();
    const [a, b] = await Promise.all([
      f.record(6000, "cash", null, order),
      f.record(4000, "cash", null, order),
    ]);
    await Promise.all([f.verify(a), f.verify(b)]);
    expect((await f.state(order)).payment_status).toBe("paid");
    await Promise.all([f.verify(a, "manager_verified", "staff_confirmed"), f.refund(a, 6000)]);
    expect(await f.state(order)).toMatchObject({
      payment_status: "paid",
      refund_status: "partial",
    });
    await f.reverse(b);
    expect((await f.state(order)).payment_status).toBe("pending");
    expect((await f.verify(a, "bank_verified", "manager_verified")).status).toBe("terminal");
  });

  it("a forced Order history failure rolls back Payment status and event too", async () => {
    const order = await f.newOrder();
    const payment = await f.record(10000, "cash", null, order);
    await f.db.exec(`CREATE FUNCTION test_reject_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced history failure'; END $$;
      CREATE TRIGGER test_reject_history BEFORE INSERT ON order_status_history
      FOR EACH ROW EXECUTE FUNCTION test_reject_history();`);
    try {
      await expect(f.verify(payment)).rejects.toThrow("forced history failure");
    } finally {
      await f.db.exec(
        "DROP TRIGGER test_reject_history ON order_status_history; DROP FUNCTION test_reject_history();",
      );
    }
    expect((await f.state(order)).payment_status).toBe("pending");
    expect(
      (await f.db.query("select status from payments where id=$1", [payment])).rows[0]!.status,
    ).toBe("pending");
    expect(
      (
        await f.db.query(
          "select count(*)::int as n from payment_events where payment_id=$1 and event_type='staff_confirmed'",
          [payment],
        )
      ).rows[0]!.n,
    ).toBe(0);
  });

  it("explicit rollback undoes both Payment and Order changes", async () => {
    const order = await f.newOrder();
    const payment = await f.record(10000, "cash", null, order);
    await f.db.exec("BEGIN");
    await f.verify(payment);
    expect((await f.state(order)).payment_status).toBe("paid");
    await f.db.exec("ROLLBACK");
    expect((await f.state(order)).payment_status).toBe("pending");
  });

  it("a failed Order refund-history write rolls back the refund event and terminal status", async () => {
    const order = await f.newOrder();
    const payment = await f.record(10000, "cash", null, order);
    await f.verify(payment);
    await f.db
      .exec(`CREATE FUNCTION test_reject_refund_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced refund history failure'; END $$;
      CREATE TRIGGER test_reject_refund_history BEFORE INSERT ON order_status_history
      FOR EACH ROW EXECUTE FUNCTION test_reject_refund_history();`);
    try {
      await expect(f.refund(payment, 10000)).rejects.toThrow("forced refund history failure");
    } finally {
      await f.db.exec(
        "DROP TRIGGER test_reject_refund_history ON order_status_history; DROP FUNCTION test_reject_refund_history();",
      );
    }
    expect(await f.state(order)).toMatchObject({
      payment_status: "paid",
      refund_status: "none",
      refunded_minor: 0,
      net_minor: 10000,
    });
    expect(
      (await f.db.query("select status from payments where id=$1", [payment])).rows[0]!.status,
    ).toBe("paid");
  });

  it("partial and full refund retry keys replay without adding a second refund event", async () => {
    const order = await f.newOrder();
    const payment = await f.record(10000, "cash", null, order);
    await f.verify(payment);
    const args = [f.org, payment, f.actor, 2000, "returned item", "refund-click"];
    const first = await f.rpc("refund_payment_v1", args);
    expect(await f.rpc("refund_payment_v1", args)).toEqual({ ...first, replayed: true });
    expect(await f.state(order)).toMatchObject({
      payment_status: "paid",
      refunded_minor: 2000,
      net_minor: 8000,
    });
    await expect(
      f.rpc("refund_payment_v1", [f.org, payment, f.actor, 3000, "returned item", "refund-click"]),
    ).rejects.toThrow("idempotency key conflicts");
    const final = [f.org, payment, f.actor, 8000, "remaining refund", "refund-final"];
    await f.rpc("refund_payment_v1", final);
    expect((await f.rpc("refund_payment_v1", final)).replayed).toBe(true);
    expect(await f.state(order)).toMatchObject({
      payment_status: "paid",
      refund_status: "full",
      refunded_minor: 10000,
    });
  });

  it("cross-tenant attach, verify, reversal and refund return no foreign information", async () => {
    const order = await f.newOrder(f.orgB);
    const payment = await f.record(10000, "cash", null, order, f.orgB);
    const unknown = crypto.randomUUID();
    for (const target of [payment, unknown]) {
      expect(await f.verify(target)).toEqual({ status: "not_found" });
      expect(await f.reverse(target)).toEqual({ status: "not_found" });
      expect(await f.refund(target, 1000)).toEqual({ status: "not_found" });
    }
    expect(
      (await f.rpc("record_payment_v1", [f.org, order, f.actor, "cash", 10000, null, null, null]))
        .status,
    ).toBe("not_found");
    await expect(
      f.db.query(
        `insert into payments(organization_id,order_id,method,currency,amount_minor)
      values($1,$2,'cash','USD',10000)`,
        [f.org, order],
      ),
    ).rejects.toThrow("cross_tenant_order");
    expect((await f.state(order)).payment_status).toBe("pending");
  });

  it("old Order RPC, direct status writes and authenticated Payment RPC access cannot bypass authority", async () => {
    const order = await f.newOrder();
    expect(
      await f.rpc("transition_order_status_v1", [
        f.org,
        order,
        "payment",
        "unpaid",
        "paid",
        f.actor,
        null,
      ]),
    ).toEqual({ status: "payment_domain_required" });
    await expect(
      f.db.query("update orders set payment_status='paid' where id=$1", [order]),
    ).rejects.toThrow("requires Payment domain");
    await expect(
      f.db.query("update orders set refund_status='full' where id=$1", [order]),
    ).rejects.toThrow("requires Payment domain");
    await f.db.exec("SET ROLE authenticated");
    try {
      await expect(f.record(10000, "cash", null, order)).rejects.toThrow("permission denied");
      await expect(f.db.query("select * from order_payment_totals")).rejects.toThrow(
        "permission denied",
      );
    } finally {
      await f.db.exec("RESET ROLE");
    }
    await f.db.exec("SET ROLE service_role");
    try {
      await expect(
        f.db.query(
          "insert into payments(organization_id,order_id,method,currency,amount_minor) values($1,$2,'cash','USD',10000)",
          [f.org, order],
        ),
      ).rejects.toThrow("permission denied");
      await expect(
        f.rpc("verify_payment_before_order_v1", [
          f.org,
          crypto.randomUUID(),
          f.actor,
          "unverified",
          "staff_confirmed",
          null,
          null,
        ]),
      ).rejects.toThrow("permission denied");
      await f.record(10000, "cash", null, order);
    } finally {
      await f.db.exec("RESET ROLE");
    }
  });

  it("principal/history cannot be rewritten and Order currency/tenant cannot detach existing Payments", async () => {
    const order = await f.newOrder();
    const payment = await f.record(10000, "cash", null, order);
    await f.verify(payment);
    await expect(
      f.db.query("update payments set amount_minor=9999 where id=$1", [payment]),
    ).rejects.toThrow("immutable");
    await expect(
      f.db.query("delete from payment_events where payment_id=$1", [payment]),
    ).rejects.toThrow("append-only");
    await expect(
      f.db.query("update orders set currency='KHR' where id=$1", [order]),
    ).rejects.toThrow("immutable");
    await expect(
      f.db.query("update orders set organization_id=$2 where id=$1", [order, f.orgB]),
    ).rejects.toThrow("immutable");
    await expect(
      f.db.query("update payments set status='reversed' where id=$1", [payment]),
    ).rejects.toThrow("commit together");
    expect((await f.state(order)).payment_status).toBe("paid");
  });
});

it("migration audits legacy paid claims and derives existing partial refunds without changing Payment history", async () => {
  const f = await financialFixture(true);
  try {
    await f.db.query("update orders set payment_status='paid' where id=$1", [f.order]);
    const settled = await f.newOrder();
    const payment = await f.record(10000, "cash", null, settled);
    await f.verify(payment);
    await f.refund(payment, 2000);
    const before = (
      await f.db.query("select * from payment_events where payment_id=$1 order by id", [payment])
    ).rows;
    await f.applyAuthority();
    expect(await f.state()).toMatchObject({ payment_status: "unpaid", refund_status: "none" });
    expect(await f.state(settled)).toMatchObject({
      payment_status: "paid",
      refund_status: "partial",
      net_minor: 8000,
    });
    // The additive idempotency column is null on old events; all old values survive.
    const after = (
      await f.db.query("select * from payment_events where payment_id=$1 order by id", [payment])
    ).rows.map(({ idempotency_key: _key, ...event }) => event);
    expect(after).toEqual(before);
    const history = (
      await f.db.query(
        "select from_status,to_status,reason from order_status_history where order_id=$1",
        [f.order],
      )
    ).rows;
    expect(history).toEqual([
      {
        from_status: "paid",
        to_status: "unpaid",
        reason: "Migration 040: recomputed from Payment ledger",
      },
    ]);
  } finally {
    await f.close();
  }
}, 15000);
