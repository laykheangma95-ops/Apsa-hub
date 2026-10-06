/**
 * Migration 061 against a REAL PostgreSQL (PGlite 0.3 = PostgreSQL 17): every
 * migration, in order. Spawned by browser-table-authority.test.ts. Never
 * touches hosted Supabase.
 *
 * Two baselines, because 061 must harden both and broaden neither:
 *
 *   PERMISSIVE — the dangerous state: Supabase's older default (ALL on every
 *                new table/sequence for anon, authenticated, service_role),
 *                PLUS default and explicit grants to PUBLIC, a global default
 *                grant, and a column-level grant. A superset of anything the
 *                privilege audit observed.
 *   RESTRICTED — the state staging was observed in: new tables inherit only
 *                TRUNCATE / REFERENCES / TRIGGER / MAINTAIN for anon,
 *                authenticated and service_role.
 *
 * Both also grant EXECUTE on new functions to anon/authenticated/service_role
 * (Supabase's function default), so every EXECUTE assertion proves a
 * migration's own REVOKE, not an environment that never granted anything.
 *
 * Proves:
 *   - the relation inventory in `public` equals the reviewed list;
 *   - after 061, PUBLIC / anon / authenticated hold no table, column or
 *     future-object privilege anywhere in `public`, from either baseline;
 *   - concrete browser attacks succeed BEFORE 061 and fail with 42501 AFTER;
 *   - service_role and postgres are byte-for-byte unchanged, and the real
 *     server workflows (orders, payments, pack, parcel, delivery, returns,
 *     products, inventory, customers, team, Customer Intelligence) run as
 *     service_role after 061;
 *   - accept_invitation / create_organization_for_founder still work for a
 *     user JWT; every other non-trigger function is closed to browser roles;
 *   - re-running 061 changes nothing;
 *   - weakened variants of 061 are caught — by 061's own post-conditions and
 *     by this file's detectors (negative proof).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  effectiveBrowserAuthority,
  migratedThrough060,
  MIGRATION_061,
  pgVersion,
} from "./helpers/browser-authority-pg";
import {
  ANON_EXECUTABLE,
  APSA_PUBLIC_RELATIONS,
  AUTHENTICATED_EXECUTABLE,
} from "./helpers/browser-authority-matrix";

const SQL_061 = readFileSync(`supabase/migrations/${MIGRATION_061}`, "utf8");
const TABLE_PRIVS = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const;
const BROWSER = ["anon", "authenticated"] as const;

// ── Catalog snapshots ────────────────────────────────────────────────────────

async function publicRelations(db: PGlite) {
  return (
    await db.query<{ relname: string; oid: number; relkind: string }>(
      `SELECT c.relname, c.oid, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S') ORDER BY c.relname`,
    )
  ).rows;
}

/** role → relation → effective privileges (includes privileges held via PUBLIC). */
async function effective(db: PGlite, roles: readonly string[]) {
  const privs: string[] = [...TABLE_PRIVS];
  if ((await pgVersion(db)) >= 170000) privs.push("MAINTAIN");
  const out: Record<string, Record<string, string[]>> = {};
  for (const role of roles) {
    out[role] = {};
    for (const rel of await publicRelations(db)) {
      const held: string[] = [];
      for (const p of privs) {
        const r = await db.query<{ h: boolean }>(
          `SELECT has_table_privilege($1, $2::oid, $3) AS h`,
          [role, rel.oid, p],
        );
        if (r.rows[0]!.h) held.push(p);
      }
      out[role]![rel.relname] = held;
    }
  }
  return out;
}

/** Every grant to PUBLIC / anon / authenticated anywhere in `public`: tables, columns, defaults. */
async function browserGrants(db: PGlite): Promise<string[]> {
  const rows = (
    await db.query<{ what: string }>(`
      WITH browser AS (
        SELECT 0::oid AS oid UNION ALL SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated')
      )
      SELECT format('table %s: %s %s', c.relname,
                    CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                    a.privilege_type) AS what
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND a.grantee IN (SELECT oid FROM browser)
      UNION ALL
      SELECT format('column %s.%s: %s %s', c.relname, att.attname,
                    CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                    a.privilege_type)
      FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(att.attacl) a
      WHERE n.nspname = 'public' AND a.grantee IN (SELECT oid FROM browser)
      UNION ALL
      SELECT format('default %s/%s: %s %s', coalesce(nullif(d.defaclnamespace, 0)::regnamespace::text, 'global'),
                    d.defaclobjtype,
                    CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                    a.privilege_type)
      FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclrole = 'postgres'::regrole AND d.defaclobjtype IN ('r','S')
        AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
        AND a.grantee IN (SELECT oid FROM browser)
      ORDER BY 1`)
  ).rows;
  return rows.map((r) => r.what);
}

/** Non-trigger functions in `public` → who may EXECUTE (PUBLIC from the stored/default ACL). */
async function executeMatrix(db: PGlite) {
  const rows = (
    await db.query<{ sig: string; pub: boolean; anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT p.oid::regprocedure::text AS sig,
        EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS pub,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prorettype <> 'trigger'::regtype
      ORDER BY 1`)
  ).rows;
  return rows.map((r) => ({ ...r, sig: r.sig.replace(/^public\./, "").replace(/, /g, ",") }));
}

async function fullAcls(db: PGlite) {
  return (
    await db.query<{ k: string; acl: string | null }>(`
      SELECT 'rel ' || c.relname AS k, c.relacl::text AS acl FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
      UNION ALL SELECT 'col ' || c.relname || '.' || a.attname, a.attacl::text FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND a.attacl IS NOT NULL
      UNION ALL SELECT 'fn ' || p.oid::regprocedure::text, p.proacl::text FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
      UNION ALL SELECT 'default ' || defaclrole::regrole::text || ' ' || defaclnamespace::text || ' ' || defaclobjtype::text,
        defaclacl::text FROM pg_default_acl
      ORDER BY 1`)
  ).rows;
}

// ── Role helpers ─────────────────────────────────────────────────────────────

async function as<T>(db: PGlite, role: string, sub: string | null, run: () => Promise<T>) {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [sub ?? ""]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec("RESET ROLE");
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  }
}

/** The SQLSTATE a statement fails with, or "ok" when it succeeds. */
async function outcome(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, params);
    return "ok";
  } catch (error) {
    return String((error as { code?: string }).code ?? error);
  }
}

/** LOCK only exists inside a transaction block. */
async function lockOutcome(db: PGlite, relation: string): Promise<string> {
  try {
    await db.exec(`BEGIN; LOCK TABLE public.${relation} IN ACCESS EXCLUSIVE MODE;`);
    await db.exec("ROLLBACK");
    return "ok";
  } catch (error) {
    await db.exec("ROLLBACK");
    return String((error as { code?: string }).code ?? error);
  }
}

// ── Seed ─────────────────────────────────────────────────────────────────────

const owner = "aaaaaaaa-0000-4000-8000-0000000000a1";
const staff = "aaaaaaaa-0000-4000-8000-0000000000a2";
const invitee = "aaaaaaaa-0000-4000-8000-0000000000a3";
const ownerB = "bbbbbbbb-0000-4000-8000-0000000000b1";

interface Seed {
  orgA: string;
  orgB: string;
  customer: string;
  product: string;
  variant: string;
}

async function rpc<T = Record<string, unknown>>(
  db: PGlite,
  name: string,
  args: unknown[],
): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(",");
  const r = await db.query<{ result: T }>(`SELECT public.${name}(${placeholders}) AS result`, args);
  return r.rows[0]!.result;
}

/** Organizations are created exactly as production does: the founder's own JWT calls the RPC. */
async function seed(db: PGlite): Promise<Seed> {
  await db.query(
    `INSERT INTO auth.users(id,email) VALUES ($1,'owner@test.invalid'),($2,'staff@test.invalid'),
       ($3,'invitee@test.invalid'),($4,'owner-b@test.invalid') ON CONFLICT DO NOTHING`,
    [owner, staff, invitee, ownerB],
  );
  const created = async (user: string, slug: string) =>
    as(db, "authenticated", user, () =>
      rpc<{ org_id?: string; status?: string }>(db, "create_organization_for_founder", [
        `Legal ${slug}`,
        `Shop ${slug}`,
        slug,
        null,
        "USD",
      ]),
    );
  const a = await created(owner, `org-a-${crypto.randomUUID().slice(0, 8)}`);
  const b = await created(ownerB, `org-b-${crypto.randomUUID().slice(0, 8)}`);
  const orgA = a.org_id!;
  const orgB = b.org_id!;
  if (!orgA || !orgB) throw new Error(`organization RPC: ${JSON.stringify([a, b])}`);
  const staffRole = (
    await db.query<{ id: string }>(
      `SELECT id FROM roles WHERE system_role = 'CASHIER' AND (organization_id IS NULL OR organization_id = $1) LIMIT 1`,
      [orgA],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO memberships(user_id,organization_id,role_id,status,joined_at) VALUES ($1,$2,$3,'active',now())`,
    [staff, orgA, staffRole],
  );
  const customer = (
    await db.query<{ id: string }>(
      `INSERT INTO customers(organization_id,display_name,primary_phone,primary_email)
       VALUES ($1,'សុខ ដារ៉ា','+85512000111','dara@test.invalid') RETURNING id`,
      [orgA],
    )
  ).rows[0]!.id;
  const product = (
    await db.query<{ id: string }>(
      `INSERT INTO products(organization_id,name_km,name_en) VALUES ($1,'អាវ','Shirt') RETURNING id`,
      [orgA],
    )
  ).rows[0]!.id;
  const variant = (
    await db.query<{ id: string }>(
      `INSERT INTO product_variants(organization_id,product_id,sku,name,price_amount,price_currency,cost_amount,cost_currency)
       VALUES ($1,$2,$3,'M',1500,'USD',900,'USD') RETURNING id`,
      [orgA, product, `SKU-${product.slice(0, 8)}`],
    )
  ).rows[0]!.id;
  return { orgA, orgB, customer, product, variant };
}

// ── The browser attack catalogue ─────────────────────────────────────────────

interface Attack {
  label: string;
  run: (db: PGlite, s: Seed) => Promise<string>;
}

const q =
  (sql: string, params?: (s: Seed) => unknown[]) =>
  (db: PGlite, s: Seed): Promise<string> =>
    outcome(db, sql, params ? params(s) : []);

const ATTACKS: Attack[] = [
  {
    label: "read customer phone/email",
    run: q("SELECT primary_phone, primary_email FROM public.customers"),
  },
  { label: "read product cost_amount", run: q("SELECT cost_amount FROM public.product_variants") },
  {
    label: "insert customer",
    run: q("INSERT INTO public.customers(organization_id,display_name) VALUES ($1,'x')", (s) => [
      s.orgA,
    ]),
  },
  { label: "update customer", run: q("UPDATE public.customers SET display_name = 'pwned'") },
  {
    label: "re-parent customer organization_id",
    run: q("UPDATE public.customers SET organization_id = $1", (s) => [s.orgB]),
  },
  { label: "update product price", run: q("UPDATE public.product_variants SET price_amount = 1") },
  {
    label: "re-parent product organization_id",
    run: q("UPDATE public.products SET organization_id = $1", (s) => [s.orgB]),
  },
  { label: "mutate customer identity", run: q("DELETE FROM public.customer_identities") },
  {
    label: "mutate profile email",
    run: q("UPDATE public.profiles SET email = 'attacker@test.invalid'"),
  },
  { label: "mutate payment", run: q("UPDATE public.payments SET amount_minor = 0") },
  { label: "insert payment", run: q("INSERT INTO public.payments DEFAULT VALUES") },
  { label: "mutate order", run: q("UPDATE public.orders SET total_minor = 0") },
  {
    label: "insert inventory movement",
    run: q("INSERT INTO public.inventory_movements DEFAULT VALUES"),
  },
  { label: "mutate delivery", run: q("UPDATE public.deliveries SET status = 'delivered'") },
  { label: "mutate parcel", run: q("UPDATE public.parcels SET updated_at = now()") },
  { label: "mutate return", run: q("UPDATE public.customer_returns SET updated_at = now()") },
  {
    label: "insert return event",
    run: q("INSERT INTO public.customer_return_events DEFAULT VALUES"),
  },
  { label: "mutate membership", run: q("UPDATE public.memberships SET status = 'active'") },
  { label: "delete audit log", run: q("DELETE FROM public.audit_logs") },
  { label: "read payment ledger view", run: q("SELECT * FROM public.order_payment_totals") },
  { label: "read stock view", run: q("SELECT * FROM public.inventory_stock") },
  { label: "TRUNCATE", run: q("TRUNCATE public.customer_tag_assignments") },
  {
    label: "REFERENCES",
    run: q(
      `CREATE TABLE scratch.ref_${crypto.randomUUID().slice(0, 8)} (c uuid REFERENCES public.customers(id))`,
    ),
  },
  {
    label: "TRIGGER",
    run: q(
      `CREATE TRIGGER t_${crypto.randomUUID().slice(0, 8)} BEFORE INSERT ON public.customers
       FOR EACH ROW EXECUTE FUNCTION scratch.noop()`,
    ),
  },
  { label: "MAINTAIN (REINDEX)", run: q("REINDEX TABLE public.customer_tags") },
  { label: "MAINTAIN/lock (LOCK ACCESS EXCLUSIVE)", run: (db) => lockOutcome(db, "customers") },
];

async function attackOutcomes(db: PGlite, s: Seed, role: "anon" | "authenticated") {
  const out: Record<string, string> = {};
  for (const attack of ATTACKS) {
    // The strongest browser identity: an ACTIVE member of the target org.
    out[attack.label] = await as(db, role, role === "authenticated" ? staff : null, () =>
      attack.run(db, s),
    );
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════

let permissivePre: PGlite;
let restrictedPre: PGlite;
let permissiveSeed: Seed;
let restrictedSeed: Seed;

// Seeded BEFORE 061, so every clone taken later carries the same rows.
beforeAll(async () => {
  permissivePre = await migratedThrough060("permissive");
  restrictedPre = await migratedThrough060("restricted");
  permissiveSeed = await seed(permissivePre);
  restrictedSeed = await seed(restrictedPre);
}, 240000);
afterAll(async () => {
  await permissivePre.close();
  await restrictedPre.close();
});

async function with061(base: PGlite, sql = SQL_061): Promise<PGlite> {
  const db = (await base.clone()) as PGlite;
  await db.exec(sql);
  return db;
}

describe("relation inventory", () => {
  it("every relation in public after 001–060 is in the reviewed 061 list, and nothing else is", async () => {
    const names = (await publicRelations(restrictedPre)).map((r) => r.relname).sort();
    expect(names).toEqual([...APSA_PUBLIC_RELATIONS].sort());
  });

  it("there are no sequences, materialized views or foreign tables to miss", async () => {
    const kinds = new Set((await publicRelations(restrictedPre)).map((r) => r.relkind));
    expect([...kinds].sort()).toEqual(["r", "v"]);
  });

  it("runs on the PostgreSQL the test claims (17, where MAINTAIN exists)", async () => {
    expect(await pgVersion(restrictedPre)).toBeGreaterThanOrEqual(170000);
  });
});

describe("PERMISSIVE baseline — 061 removes the dangerous browser authority", () => {
  let post: PGlite;
  let s: Seed;
  beforeAll(async () => {
    s = permissiveSeed;
    post = await with061(permissivePre);
  }, 120000);
  afterAll(async () => {
    await post.close();
  });

  it("BEFORE 061 the baseline really is dangerous (attacks succeed — the tests are not vacuous)", async () => {
    const probe = (await permissivePre.clone()) as PGlite;
    try {
      expect((await browserGrants(probe)).length).toBeGreaterThan(0);
      const anon = await attackOutcomes(probe, s, "anon");
      const auth = await attackOutcomes(probe, s, "authenticated");
      // RLS hides rows from anon but cannot stop these:
      for (const label of ["TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN (REINDEX)"]) {
        expect({ label, anon: anon[label] }).toEqual({ label, anon: "ok" });
      }
      // An active STAFF member reads cost and rewrites price directly, bypassing
      // the server's products.view_cost / products.update_price checks.
      expect(auth["read product cost_amount"]).toBe("ok");
      expect(auth["update product price"]).toBe("ok");
      expect(auth["read customer phone/email"]).toBe("ok");
      expect(auth["mutate profile email"]).toBe("ok");
      const cost = await as(
        probe,
        "authenticated",
        staff,
        async () =>
          (await probe.query<{ c: number }>("SELECT cost_amount AS c FROM public.product_variants"))
            .rows,
      );
      expect(cost).toEqual([{ c: 900 }]);
    } finally {
      await probe.close();
    }
  });

  it("AFTER 061: no table, column or default privilege for PUBLIC, anon or authenticated anywhere", async () => {
    expect(await browserGrants(post)).toEqual([]);
    expect(await effectiveBrowserAuthority(post)).toEqual([]);
    const eff = await effective(post, BROWSER);
    for (const role of BROWSER) {
      for (const [rel, privs] of Object.entries(eff[role]!)) {
        expect({ role, rel, privs }).toEqual({ role, rel, privs: [] });
      }
    }
  });

  it("AFTER 061: every attack fails with 42501 for anon AND for an authenticated org member", async () => {
    for (const role of BROWSER) {
      const result = await attackOutcomes(post, s, role);
      for (const [label, code] of Object.entries(result)) {
        expect({ role, label, code }).toEqual({ role, label, code: "42501" });
      }
    }
    // and nothing was changed by the attempts
    const row = (
      await post.query<{ price_amount: number; organization_id: string }>(
        "SELECT price_amount, organization_id FROM public.product_variants WHERE id = $1",
        [s.variant],
      )
    ).rows[0]!;
    expect(row).toEqual({ price_amount: 1500, organization_id: s.orgA });
  });

  it("service_role and the owner are unchanged — except ledger writes PUBLIC had handed back", async () => {
    const before = await effective(permissivePre, ["service_role", "postgres"]);
    const after = await effective(post, ["service_role", "postgres"]);
    expect(after.postgres).toEqual(before.postgres);
    const ledger = ["payments", "payment_events", "payment_evidence"];
    const writes = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];
    for (const [rel, privs] of Object.entries(before.service_role!)) {
      if (!ledger.includes(rel)) {
        expect({ rel, privs: after.service_role![rel] }).toEqual({ rel, privs });
        continue;
      }
      // In this worst case PUBLIC re-opened what 040 revoked from service_role;
      // 061 closing PUBLIC restores 040: the ledger is SELECT-only again.
      expect(privs).toEqual(expect.arrayContaining(writes));
      expect(after.service_role![rel]).toEqual(privs.filter((p) => !writes.includes(p)));
      expect(after.service_role![rel]).toContain("SELECT");
    }
  });

  it("a table and a sequence created after 061 inherit no browser authority", async () => {
    const db = (await post.clone()) as PGlite;
    try {
      await db.exec(
        "CREATE TABLE public.zz_future (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text)",
      );
      await db.exec("CREATE SEQUENCE public.zz_future_seq");
      expect(await browserGrants(db)).toEqual([]);
      const eff = await effective(db, [...BROWSER, "service_role"]);
      for (const role of BROWSER) {
        expect(eff[role]!.zz_future).toEqual([]);
        expect(eff[role]!.zz_future_seq).toEqual([]);
      }
      // service_role's own default (ALL in this baseline) is untouched by 061
      expect(eff.service_role!.zz_future).toContain("SELECT");
      for (const role of BROWSER) {
        expect(await as(db, role, null, () => outcome(db, "SELECT * FROM public.zz_future"))).toBe(
          "42501",
        );
        expect(
          await as(db, role, null, () => outcome(db, "SELECT nextval('public.zz_future_seq')")),
        ).toBe("42501");
      }
    } finally {
      await db.close();
    }
  });

  it("function EXECUTE is untouched by 061", async () => {
    expect(await executeMatrix(post)).toEqual(await executeMatrix(permissivePre));
  });
});

describe("RESTRICTED baseline — 061 is safe and never broadens authority", () => {
  let post: PGlite;
  let s: Seed;
  beforeAll(async () => {
    s = restrictedSeed;
    post = await with061(restrictedPre);
  }, 120000);
  afterAll(async () => {
    await post.close();
  });

  it("BEFORE 061 the staging-observed inheritance is real (Dxtm for both browser roles)", async () => {
    const eff = await effective(restrictedPre, BROWSER);
    expect(eff.anon!.customers).toEqual(["TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]);
    expect(eff.authenticated!.products).toEqual(["TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]);
  });

  it("AFTER 061: no browser privilege anywhere, and every attack fails with 42501", async () => {
    expect(await browserGrants(post)).toEqual([]);
    expect(await effectiveBrowserAuthority(post)).toEqual([]);
    for (const role of BROWSER) {
      const result = await attackOutcomes(post, s, role);
      for (const [label, code] of Object.entries(result)) {
        expect({ role, label, code }).toEqual({ role, label, code: "42501" });
      }
    }
  });

  it("no role gains any privilege on any relation (061 only removes)", async () => {
    const roles = ["anon", "authenticated", "service_role", "postgres"];
    const before = await effective(restrictedPre, roles);
    const after = await effective(post, roles);
    for (const role of roles) {
      for (const [rel, privs] of Object.entries(after[role]!)) {
        for (const p of privs)
          expect({ role, rel, p, held: before[role]![rel] }).toEqual({
            role,
            rel,
            p,
            held: expect.arrayContaining([p]),
          });
      }
    }
    expect(after.service_role).toEqual(before.service_role);
    expect(after.postgres).toEqual(before.postgres);
  });

  it("re-running 061 changes nothing (idempotent)", async () => {
    const db = (await post.clone()) as PGlite;
    try {
      const once = await fullAcls(db);
      await db.exec(SQL_061);
      await db.exec(SQL_061);
      expect(await fullAcls(db)).toEqual(once);
    } finally {
      await db.close();
    }
  });

  it("a table created after 061 inherits no browser authority; service_role's default is unchanged", async () => {
    const db = (await post.clone()) as PGlite;
    try {
      await db.exec("CREATE TABLE public.zz_future (id uuid PRIMARY KEY)");
      const eff = await effective(db, [...BROWSER, "service_role"]);
      expect(eff.anon!.zz_future).toEqual([]);
      expect(eff.authenticated!.zz_future).toEqual([]);
      expect(eff.service_role!.zz_future).toEqual([
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
      ]);
      expect(await browserGrants(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe("RPC EXECUTE authority after 061", () => {
  let post: PGlite;
  beforeAll(async () => {
    post = await with061(restrictedPre);
  });
  afterAll(async () => {
    await post.close();
  });

  it("anon may execute only the RLS helpers; authenticated additionally only the two user RPCs", async () => {
    const m = await executeMatrix(post);
    expect(
      m
        .filter((f) => f.anon)
        .map((f) => f.sig)
        .sort(),
    ).toEqual(ANON_EXECUTABLE);
    expect(
      m
        .filter((f) => f.auth)
        .map((f) => f.sig)
        .sort(),
    ).toEqual(AUTHENTICATED_EXECUTABLE);
    expect(
      m
        .filter((f) => f.pub)
        .map((f) => f.sig)
        .sort(),
    ).toEqual(ANON_EXECUTABLE);
  });

  it("service_role can execute every non-trigger business RPC except the pre-040 internals", async () => {
    const m = await executeMatrix(post);
    const closed = m.filter((f) => !f.svc).map((f) => f.sig);
    for (const sig of closed) {
      // 040/043 renamed the pre-authority implementations; only DEFINER wrappers call them.
      expect(sig).toMatch(
        /_before_(order|payment_authority)_v1\(|^lock_payment_order\(|^sync_order_payment_state\(/,
      );
    }
  });

  it("Customer Intelligence (060) stays service_role-only", async () => {
    const ci = (await executeMatrix(post)).find((f) =>
      f.sig.startsWith("customer_purchase_profile_v1("),
    );
    expect(ci).toMatchObject({ pub: false, anon: false, auth: false, svc: true });
  });

  it("browser roles calling service-only business RPCs are refused with 42501", async () => {
    const calls = [
      "SELECT public.create_order_v3(gen_random_uuid(),gen_random_uuid(),'MANUAL','[]'::jsonb,null,null,0,0,null,'k',null,null,null)",
      "SELECT public.transition_order_status_v1(gen_random_uuid(),gen_random_uuid(),'lifecycle','draft','confirmed',null,null)",
      "SELECT public.record_payment_v1(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'cash',1,null,null,null)",
      "SELECT public.record_order_packed_v1(gen_random_uuid(),gen_random_uuid(),null)",
      "SELECT public.complete_customer_return_v1(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{}'::jsonb)",
      "SELECT public.record_stock_count_v1(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),null,1,0)",
      "SELECT public.customer_purchase_profile_v1(gen_random_uuid(),gen_random_uuid(),true,true,true,true,10)",
    ];
    for (const role of BROWSER) {
      for (const sql of calls) {
        expect({ role, sql, code: await as(post, role, owner, () => outcome(post, sql)) }).toEqual({
          role,
          sql,
          code: "42501",
        });
      }
    }
  });
});

describe("intentional user-token RPCs still work after 061", () => {
  let db: PGlite;
  let s: Seed;
  const founder = "cccccccc-0000-4000-8000-0000000000c1";
  beforeAll(async () => {
    db = await with061(restrictedPre);
    s = restrictedSeed;
    await db.query("INSERT INTO auth.users(id,email) VALUES ($1,'founder@test.invalid')", [
      founder,
    ]);
  }, 60000);
  afterAll(async () => {
    await db.close();
  });

  it("create_organization_for_founder creates the org and owner membership for the JWT's user", async () => {
    const created = await as(db, "authenticated", founder, () =>
      rpc<{ org_id: string; status: string }>(db, "create_organization_for_founder", [
        "Founder Legal",
        "Founder Shop",
        "founder-061",
        null,
        "USD",
      ]),
    );
    expect(created.status).toBe("success");
    const m = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships m JOIN roles r ON r.id = m.role_id
       WHERE m.user_id = $1 AND m.organization_id = $2 AND r.system_role = 'OWNER' AND m.status = 'active'`,
      [founder, created.org_id],
    );
    expect(m.rows[0]!.n).toBe(1);
    // and it is still closed to anon
    expect(
      await as(db, "anon", null, () =>
        outcome(db, "SELECT public.create_organization_for_founder('x','x','x-anon',null,'USD')"),
      ),
    ).toBe("42501");
  });

  it("accept_invitation accepts a server-issued invitation for the matching JWT", async () => {
    const role = (
      await db.query<{ id: string }>(
        `SELECT id FROM roles WHERE system_role = 'CASHIER' AND (organization_id IS NULL OR organization_id = $1) LIMIT 1`,
        [s.orgA],
      )
    ).rows[0]!.id;
    await as(db, "service_role", null, () =>
      db.query(
        `INSERT INTO invitations(organization_id,email,role_id,token_hash,invited_by,issued_by_role,expires_at)
         VALUES ($1,'invitee@test.invalid',$2,'hash-061-accept',$3,'OWNER',now() + interval '1 day')`,
        [s.orgA, role, owner],
      ),
    );
    const result = await as(db, "authenticated", invitee, () =>
      rpc<{ status: string }>(db, "accept_invitation", ["hash-061-accept"]),
    );
    expect(result.status).toBe("success");
    const member = await db.query<{ status: string }>(
      "SELECT status FROM memberships WHERE user_id = $1 AND organization_id = $2",
      [invitee, s.orgA],
    );
    expect(member.rows).toEqual([{ status: "active" }]);
    expect(
      await as(db, "anon", null, () =>
        outcome(db, "SELECT public.accept_invitation('hash-061-accept')"),
      ),
    ).toBe("42501");
  });
});

describe("service_role server workflows after 061 (RESTRICTED: service_role holds only explicit grants)", () => {
  let db: PGlite;
  let s: Seed;
  const svc = <T>(run: () => Promise<T>) => as(db, "service_role", null, run);
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.query<T>(sql, params)).rows[0]!;
  let order = "";

  beforeAll(async () => {
    db = await with061(restrictedPre);
    s = restrictedSeed;
  }, 60000);
  afterAll(async () => {
    await db.close();
  });

  it("customers: create, update, identities, notes, tags, addresses", async () => {
    await svc(async () => {
      const c = await one<{ id: string }>(
        "INSERT INTO customers(organization_id,display_name) VALUES ($1,'Server customer') RETURNING id",
        [s.orgA],
      );
      await db.query("UPDATE customers SET display_name = 'Renamed' WHERE id = $1", [c.id]);
      await db.query(
        `INSERT INTO customer_identities(organization_id,customer_id,provider,provider_user_id)
         VALUES ($1,$2,'TELEGRAM','tg-061')`,
        [s.orgA, c.id],
      );
      await db.query("DELETE FROM customer_identities WHERE customer_id = $1", [c.id]);
      await db.query(
        "INSERT INTO customer_notes(organization_id,customer_id,body,author_user_id) VALUES ($1,$2,'note',$3)",
        [s.orgA, c.id, owner],
      );
      const tag = await one<{ id: string }>(
        "INSERT INTO customer_tags(organization_id,name) VALUES ($1,'VIP') RETURNING id",
        [s.orgA],
      );
      await db.query("INSERT INTO customer_tag_assignments(customer_id,tag_id) VALUES ($1,$2)", [
        c.id,
        tag.id,
      ]);
      await db.query("DELETE FROM customer_tag_assignments WHERE tag_id = $1", [tag.id]);
      await db.query("SELECT * FROM customer_addresses WHERE organization_id = $1", [s.orgA]);
    });
  });

  it("products and inventory: catalogue writes, price change, restock, stock view, stock count", async () => {
    await svc(async () => {
      await db.query(
        "INSERT INTO product_categories(organization_id,name_km) VALUES ($1,'សម្លៀកបំពាក់')",
        [s.orgA],
      );
      await db.query("UPDATE product_variants SET price_amount = 1600 WHERE id = $1", [s.variant]);
      await db.query("UPDATE products SET name_en = 'Shirt v2' WHERE id = $1", [s.product]);
      await db.query(
        `INSERT INTO inventory_movements(organization_id,product_id,variant_id,quantity_delta,movement_type)
         VALUES ($1,$2,$3,10,'restock')`,
        [s.orgA, s.product, s.variant],
      );
      const stock = await one<{ q: number }>(
        "SELECT sum(quantity_on_hand)::int AS q FROM inventory_stock WHERE variant_id = $1",
        [s.variant],
      );
      expect(stock.q).toBe(10);
      const found = await db.query("SELECT * FROM search_stock_count_variants_v1($1,'SKU',10)", [
        s.orgA,
      ]);
      expect(found.rows.length).toBe(1);
      const count = await rpc<{ status: string }>(db, "record_stock_count_v1", [
        s.orgA,
        owner,
        crypto.randomUUID(),
        s.variant,
        null,
        10,
        10,
      ]);
      expect(count.status).toBe("recorded");
    });
  });

  it("orders, payments, pack, parcel, delivery: the full fulfilment path", async () => {
    await svc(async () => {
      const created = await rpc<{ status: string; order_id: string }>(db, "create_order_v3", [
        s.orgA,
        owner,
        "MANUAL",
        JSON.stringify([{ variant_id: s.variant, quantity: 2 }]),
        s.customer,
        null,
        0,
        0,
        null,
        "fixture-aaaaaaaaaaaaaaaa",
        "Dara",
        "+85512000111",
        "Phnom Penh",
      ]);
      expect(created.status).toBe("success");
      order = created.order_id;
      const confirmed = await rpc<{ status: string }>(db, "transition_order_status_v1", [
        s.orgA,
        order,
        "lifecycle",
        "draft",
        "confirmed",
        owner,
        null,
      ]);
      expect(confirmed.status).toBe("success");
      const total = await one<{ total_minor: number }>(
        "SELECT total_minor FROM orders WHERE id = $1",
        [order],
      );
      const paid = await rpc<{ status: string; payment_id: string }>(db, "record_payment_v1", [
        s.orgA,
        order,
        owner,
        "cash",
        total.total_minor,
        null,
        null,
        null,
      ]);
      expect(paid.status).toBe("success");
      const verified = await rpc<{ status: string }>(db, "verify_payment_v1", [
        s.orgA,
        paid.payment_id,
        owner,
        "unverified",
        "staff_confirmed",
        "cash counted",
        null,
      ]);
      expect(verified.status).toBe("success");
      const totals = await one<{ net_minor: number }>(
        "SELECT net_minor FROM order_payment_totals WHERE order_id = $1",
        [order],
      );
      expect(Number(totals.net_minor)).toBe(total.total_minor);
      const parcel = await db.query("SELECT id FROM parcels WHERE order_id = $1", [order]);
      expect(parcel.rows.length).toBe(1);
      const recovered = await rpc<{ status: string }>(db, "recover_order_parcel_v1", [
        s.orgA,
        order,
        owner,
      ]);
      expect(typeof recovered.status).toBe("string");
      const packed = await rpc<{ status: string }>(db, "record_order_packed_v1", [
        s.orgA,
        order,
        owner,
      ]);
      expect(packed.status).toBe("success");
      const delivery = await rpc<{ status: string; delivery_id: string }>(
        db,
        "create_delivery_v1",
        [s.orgA, order, owner, null, null, null, "Manual courier", null, null],
      );
      expect(delivery.status).toBe("success");
      const ready = await rpc<{ status: string }>(db, "ready_packed_delivery_v1", [
        s.orgA,
        order,
        delivery.delivery_id,
        owner,
      ]);
      expect(ready.status).toBe("success");
      for (const [from, to] of [
        ["ready", "in_transit"],
        ["in_transit", "delivered"],
      ]) {
        const moved = await rpc<{ status: string }>(db, "transition_delivery_status_v1", [
          s.orgA,
          delivery.delivery_id,
          from,
          to,
          owner,
          null,
        ]);
        expect({ to, status: moved.status }).toEqual({ to, status: "success" });
      }
    });
  });

  it("returns: request, receive, inspect, complete", async () => {
    await svc(async () => {
      const item = await one<{ id: string }>("SELECT id FROM order_items WHERE order_id = $1", [
        order,
      ]);
      const requested = await rpc<{ status: string; return_id: string }>(
        db,
        "request_customer_return_v1",
        [
          s.orgA,
          owner,
          crypto.randomUUID(),
          order,
          JSON.stringify([{ order_item_id: item.id, quantity: 1 }]),
        ],
      );
      expect(requested.status).toBe("requested");
      const received = await rpc<{ status: string }>(db, "receive_customer_return_v1", [
        s.orgA,
        owner,
        requested.return_id,
      ]);
      expect(received.status).toBe("received");
      const line = await one<{ id: string }>(
        "SELECT id FROM customer_return_items WHERE return_id = $1",
        [requested.return_id],
      );
      const inspected = await rpc<{ status: string }>(db, "inspect_customer_return_v1", [
        s.orgA,
        owner,
        requested.return_id,
        JSON.stringify([{ return_item_id: line.id, damaged_quantity: 0 }]),
      ]);
      expect(inspected.status).toBe("inspected");
      const expected = await one<{ e: unknown }>(
        "SELECT customer_return_current_inspection_v1($1) AS e",
        [requested.return_id],
      );
      const completed = await rpc<{ status: string }>(db, "complete_customer_return_v1", [
        s.orgA,
        owner,
        requested.return_id,
        JSON.stringify(expected.e),
      ]);
      expect(completed.status).toBe("completed");
    });
  });

  it("Customer Intelligence (060) reads the whole history as service_role", async () => {
    const profile = await svc(() =>
      rpc<Record<string, unknown>>(db, "customer_purchase_profile_v1", [
        s.orgA,
        s.customer,
        true,
        true,
        true,
        true,
        10,
      ]),
    );
    expect(profile.customer_found).toBe(true);
    expect(JSON.stringify(profile)).toContain(order);
  });

  it("team, audit, analytics and operability paths", async () => {
    await svc(async () => {
      await db.query("UPDATE organizations SET display_name = display_name WHERE id = $1", [
        s.orgA,
      ]);
      await db.query("UPDATE memberships SET status = status WHERE organization_id = $1", [s.orgA]);
      await db.query(
        `INSERT INTO audit_logs(organization_id,actor_user_id,action,resource_type,resource_id)
         VALUES ($1,$2,'test.061','organization',$3)`,
        [s.orgA, owner, s.orgA],
      );
      await db.query("SELECT * FROM permissions, role_permissions LIMIT 1");
      await db.query("SELECT * FROM locations, workspaces, profiles LIMIT 1");
      await db.query("SELECT * FROM payment_reconciliation_summary LIMIT 1");
      await db.query(
        "SELECT * FROM analytics_period_status_counts_v1($1, now() - interval '1 day', now())",
        [s.orgA],
      );
      await db.query("SELECT consume_rate_limit(repeat('a', 64),'rule',5,60)");
      await db.query("SELECT claim_webhook_event('test','evt-061')");
    });
  });
});

// ── Negative proof: weakened 061 variants are caught ─────────────────────────

const POSTCONDITIONS = /\n-- ── 3–6\. Post-conditions[\s\S]*?\n\$\$;\n/;
const withoutPostconditions = (sql: string) => {
  const stripped = sql.replace(/\r\n/g, "\n").replace(POSTCONDITIONS, "\n");
  if (stripped === sql.replace(/\r\n/g, "\n")) throw new Error("post-condition block not found");
  return stripped;
};
const tableRevokes = (sql: string, grantees: string) =>
  sql.replace(
    /(REVOKE ALL ON TABLE public\.\w+\s+)FROM PUBLIC, anon, authenticated;/g,
    `$1FROM ${grantees};`,
  );
const DEFAULTS = /ALTER DEFAULT PRIVILEGES[^;]*;\n/g;

describe("negative proof — the detectors fail when 061 is weakened", () => {
  const variants: Array<{ name: string; sql: string; leaked: RegExp }> = [
    {
      name: "authenticated table revoke removed",
      sql: tableRevokes(SQL_061, "PUBLIC, anon"),
      leaked: /: authenticated /,
    },
    {
      name: "anon table revoke removed",
      sql: tableRevokes(SQL_061, "PUBLIC, authenticated"),
      leaked: /: anon /,
    },
    {
      name: "PUBLIC table revoke removed",
      sql: tableRevokes(SQL_061, "anon, authenticated"),
      leaked: /: PUBLIC /,
    },
    {
      name: "default-privilege hardening removed",
      sql: SQL_061.replace(/\r\n/g, "\n").replace(DEFAULTS, ""),
      leaked: /^default /,
    },
  ];

  for (const v of variants) {
    it(`${v.name}: 061's own post-condition aborts the migration`, async () => {
      const db = (await permissivePre.clone()) as PGlite;
      try {
        await expect(db.exec(v.sql)).rejects.toThrow(/061: /);
      } finally {
        await db.close();
      }
    });

    it(`${v.name}: with the post-condition also removed, this file's detector reports the leak`, async () => {
      const db = await with061(permissivePre, withoutPostconditions(v.sql));
      try {
        const leaks = await browserGrants(db);
        expect(leaks.some((l) => v.leaked.test(l))).toBe(true);
      } finally {
        await db.close();
      }
    });
  }

  it("default-privilege hardening removed: a future table is browser-readable again", async () => {
    const weakened = withoutPostconditions(SQL_061.replace(/\r\n/g, "\n").replace(DEFAULTS, ""));
    const db = await with061(permissivePre, weakened);
    try {
      await db.exec("CREATE TABLE public.zz_future (id uuid PRIMARY KEY)");
      expect(await as(db, "anon", null, () => outcome(db, "SELECT * FROM public.zz_future"))).toBe(
        "ok",
      );
    } finally {
      await db.close();
    }
  });

  it("server authority removed: the post-condition aborts; without it the service-role path fails", async () => {
    const hostile = SQL_061.replace(/\r\n/g, "\n").replace(
      "-- ── 2. Future relations",
      "REVOKE SELECT ON TABLE public.customers FROM service_role;\n-- ── 2. Future relations",
    );
    const aborted = (await restrictedPre.clone()) as PGlite;
    try {
      await expect(aborted.exec(hostile)).rejects.toThrow(/061: service_role lost authority/);
    } finally {
      await aborted.close();
    }
    const db = await with061(restrictedPre, withoutPostconditions(hostile));
    try {
      expect((await effective(db, ["service_role"])).service_role!.customers).not.toContain(
        "SELECT",
      );
      expect(await as(db, "service_role", null, () => outcome(db, "SELECT * FROM customers"))).toBe(
        "42501",
      );
    } finally {
      await db.close();
    }
  });

  it("authority held only through PUBLIC: 061 aborts instead of silently removing it from service_role", async () => {
    const db = (await restrictedPre.clone()) as PGlite;
    try {
      await db.exec(`
        REVOKE SELECT ON public.locations FROM service_role;
        GRANT SELECT ON public.locations TO PUBLIC;
      `);
      await expect(db.exec(SQL_061)).rejects.toThrow(
        /061: service_role lost authority[^\n]*SELECT locations/,
      );
    } finally {
      await db.close();
    }
  });

  it("an unlisted relation that still carries a browser grant aborts 061 by name", async () => {
    const db = (await restrictedPre.clone()) as PGlite;
    try {
      await db.exec(
        "CREATE TABLE public.zz_drift (id int); GRANT SELECT ON public.zz_drift TO anon;",
      );
      await expect(db.exec(SQL_061)).rejects.toThrow(
        /061: browser authority remains[^\n]*anon SELECT on zz_drift/,
      );
    } finally {
      await db.close();
    }
  });
});
