import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";

export async function financialFixture(skipAuthority = false) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
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
    if (skipAuthority && name.startsWith("040_")) continue;
    try {
      await db.exec(readFileSync(`supabase/migrations/${name}`, "utf8"));
    } catch (error) {
      await db.close();
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }
  const org = "aaaaaaaa-0000-4000-8000-000000000001";
  const orgB = "bbbbbbbb-0000-4000-8000-000000000001";
  const actor = "aaaaaaaa-0000-4000-8000-000000000002";
  await db.query("insert into auth.users(id,email) values($1,'payment@test.invalid')", [actor]);
  await db.query(
    `insert into organizations(id,legal_name,display_name,slug,created_by)
    values($1,'A','A','payment-a',$3),($2,'B','B','payment-b',$3)`,
    [org, orgB, actor],
  );
  async function newOrder(tenant = org, total = 10000) {
    const id = crypto.randomUUID();
    await db.query(
      `insert into orders(id,organization_id,order_number,source,currency,
      subtotal_minor,total_minor,created_by) values($1,$2,$1::uuid::text,'MANUAL','USD',$3,$3,$4)`,
      [id, tenant, total, actor],
    );
    return id;
  }
  const order = await newOrder();
  async function rpc(name: string, args: unknown[]) {
    const params = args.map((_, i) => `$${i + 1}`).join(",");
    const result = await db.query<{ result: Record<string, unknown> }>(
      `select ${name}(${params}) as result`,
      args,
    );
    return result.rows[0]!.result;
  }
  async function record(
    amount: number,
    method = "cash",
    key: string | null = null,
    target = order,
    tenant = org,
  ) {
    const result = await rpc("record_payment_v1", [
      tenant,
      target,
      actor,
      method,
      amount,
      null,
      key,
      null,
    ]);
    if (result.status !== "success") throw new Error(JSON.stringify(result));
    return result.payment_id as string;
  }
  async function verify(
    payment: string,
    to = "staff_confirmed",
    from = "unverified",
    tenant = org,
  ) {
    return rpc("verify_payment_v1", [tenant, payment, actor, from, to, "test", null]);
  }
  async function refund(payment: string, amount: number, tenant = org) {
    return rpc("refund_payment_v1", [tenant, payment, actor, amount, "test refund"]);
  }
  async function reverse(payment: string, tenant = org) {
    return rpc("reverse_payment_v1", [tenant, payment, actor, "test reversal"]);
  }
  async function state(target = order) {
    return (
      await db.query(
        `select o.payment_status,o.refund_status,
      t.received_minor,t.refunded_minor,t.net_minor
      from orders o join order_payment_totals t on t.order_id=o.id where o.id=$1`,
        [target],
      )
    ).rows[0]!;
  }
  return {
    db,
    org,
    orgB,
    actor,
    order,
    rpc,
    record,
    verify,
    refund,
    reverse,
    state,
    newOrder,
    close: () => db.close(),
    applyAuthority: () =>
      db.exec(readFileSync("supabase/migrations/040_payment_order_authority.sql", "utf8")),
  };
}
