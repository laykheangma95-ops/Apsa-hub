/**
 * Product-image upload ticket lifecycle (migration 050) against a REAL PGlite
 * replay of every migration. The production repository + service run unchanged
 * over a small SQL-backed client (`sqlClient`); only object storage is faked.
 *
 * Concurrency note: PGlite is one embedded connection, so concurrent promises
 * interleave at statement/transaction granularity, not as parallel backends.
 * That still exercises the exact races the review found (the service's own
 * awaits interleave with each other and with the sweep). True multi-connection
 * parallelism under hosted Postgres remains a staging check.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import type { AuthorizationContext } from "../server/auth/authorization";
import { buildProductImagePath } from "../lib/product-image";
import { financialFixture } from "./helpers/payment-order-fixture";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";
const PRODUCT_A = "a1000000-0000-4000-8000-000000000001";
const PRODUCT_B = "b1000000-0000-4000-8000-000000000001";
const uid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const objId = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ── A structurally valid JPEG (same construction as product-image.test.ts) ───
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const tag = (t: string) => Array.from(t, (c) => c.charCodeAt(0));
const JPEG = new Uint8Array([
  0xff,
  0xd8,
  ...[0xff, 0xe0, ...be16(16), ...tag("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
  ...[0xff, 0xc0, ...be16(17), 8, ...be16(48), ...be16(64), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  ...[0xff, 0xda, ...be16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0],
  0x12,
  0x34,
  0xff,
  0xd9,
]);

// ── SQL-backed PostgREST subset used by the product repository ───────────────
const RPC_TYPES: Record<string, string> = {
  p_org: "uuid",
  p_product: "uuid",
  p_user: "uuid",
  p_path: "text",
  p_ttl_seconds: "integer",
  p_member_cap: "integer",
  p_org_cap: "integer",
  p_claim_seconds: "integer",
  p_limit: "integer",
  p_lease_seconds: "integer",
  p_ids: "uuid[]",
};

function sqlClient(db: PGlite) {
  const ident = (v: string) => {
    if (!/^[a-z_0-9]+$/.test(v)) throw new Error(`bad identifier ${v}`);
    return v;
  };
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      try {
        const vals: unknown[] = [];
        const parts = Object.entries(args).map(([k, v]) => {
          vals.push(Array.isArray(v) ? `{${v.join(",")}}` : v);
          return `${ident(k)} => $${vals.length}::${RPC_TYPES[k]}`;
        });
        const r = await db.query<Record<string, unknown>>(
          `select * from ${ident(name)}(${parts.join(",")})`,
          vals,
        );
        if (name === "take_product_image_upload_cleanup_v1") {
          return { data: JSON.parse(JSON.stringify(r.rows)), error: null };
        }
        return { data: (r.rows[0]?.[name] as unknown) ?? null, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
    from(table: string) {
      const where: string[] = [];
      const vals: unknown[] = [];
      let op: "select" | "update" | "delete" = "select";
      let cols = "*";
      let patch: Record<string, unknown> = {};
      let single = false;
      let wantRows = false;
      const bind = (v: unknown) => (vals.push(v), `$${vals.length}`);
      const q: Record<string, unknown> = {
        select(c = "*") {
          cols = c;
          wantRows = true;
          return q;
        },
        update(p: Record<string, unknown>) {
          op = "update";
          patch = p;
          return q;
        },
        delete() {
          op = "delete";
          return q;
        },
        eq(k: string, v: unknown) {
          where.push(`${ident(k)} = ${bind(v)}`);
          return q;
        },
        in(k: string, items: unknown[]) {
          where.push(`${ident(k)} in (${items.map(bind).join(",")})`);
          return q;
        },
        single() {
          single = true;
          return q;
        },
        async then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
          try {
            let sql: string;
            if (op === "update") {
              const set = Object.entries(patch)
                .map(([k, v]) => `${ident(k)} = ${bind(v)}`)
                .join(",");
              sql = `update ${ident(table)} set ${set}`;
            } else if (op === "delete") sql = `delete from ${ident(table)}`;
            else sql = `select ${cols} from ${ident(table)}`;
            if (where.length) sql += ` where ${where.join(" and ")}`;
            if (op !== "select" && wantRows) sql += ` returning ${cols}`;
            const r = await db.query(sql, vals);
            const rows = JSON.parse(JSON.stringify(r.rows));
            if (single) {
              return ok(
                rows.length
                  ? { data: rows[0], error: null }
                  : { data: null, error: { code: "PGRST116" } },
              );
            }
            return ok({ data: op === "select" || wantRows ? rows : null, error: null });
          } catch (error) {
            return ok({ data: null, error }); // resolves as { error }, like supabase-js
          }
          void bad;
        },
      };
      return q;
    },
  };
}

// ── Fake object storage ──────────────────────────────────────────────────────
class FakeStorage {
  objects = new Map<string, { head: Uint8Array; sizeBytes: number }>();
  removed: string[] = [];
  signed: string[] = [];
  failAll = false;
  failPaths = new Set<string>();
  inspectGate: Promise<void> | null = null;
  inspectStarted: (() => void) | null = null;
  put(p: string, head = JPEG) {
    this.objects.set(p, { head, sizeBytes: head.length });
  }
  async createUpload(p: string) {
    this.signed.push(p);
    return { signedUrl: `https://storage.test/upload?p=${encodeURIComponent(p)}`, path: p };
  }
  async createReadUrls(paths: string[]) {
    return new Map(paths.map((p) => [p, `https://storage.test/read/${p}`]));
  }
  async inspect(p: string) {
    const found = this.objects.get(p) ?? null;
    this.inspectStarted?.();
    if (this.inspectGate) await this.inspectGate;
    return found;
  }
  async remove(paths: string[]) {
    for (const p of paths) {
      if (this.failAll || this.failPaths.has(p)) throw new Error("remove down");
      this.objects.delete(p);
      this.removed.push(p);
    }
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let storage: FakeStorage;
let restore: Array<() => void> = [];

const ctxFor = (org: string, user: number): AuthorizationContext =>
  ({
    userId: uid(user),
    organizationId: org,
    permissions: new Set(["products.read", "products.update_basic"]),
    can: () => true,
    require: () => undefined,
  }) as unknown as AuthorizationContext;

const svc = () => import("../server/products/image-service");
const ask = async (org = ORG_A, user = 1, product = PRODUCT_A) =>
  (await svc()).requestProductImageUpload(ctxFor(org, user), product, {
    mimeType: "image/jpeg",
    sizeBytes: 1000,
  });
const attach = async (path: string, org = ORG_A, user = 1, product = PRODUCT_A) =>
  (await svc()).attachProductImage(ctxFor(org, user), product, path);
const rows = async (where = "true") =>
  (await db.query(`select * from product_image_uploads where ${where} order by created_at, id`))
    .rows;
const ticketOf = async (path: string) =>
  (await db.query("select * from product_image_uploads where object_path = $1", [path])).rows[0];
const productImage = async (id = PRODUCT_A) =>
  (await db.query("select image_path from products where id = $1", [id])).rows[0].image_path as
    string | null;
const past = "now() - interval '1 minute'";

let seq = 0;
/** Insert a ticket directly, as if issued earlier. */
async function seedTicket(opts: {
  org?: string;
  product?: string;
  user?: number;
  state?: string;
  expired?: boolean;
  errors?: number;
  retryAfterPast?: boolean;
  withObject?: boolean;
}) {
  const org = opts.org ?? ORG_A;
  const product = opts.product ?? PRODUCT_A;
  const path = buildProductImagePath(org, product, objId(++seq), "image/jpeg");
  await db.query(
    `insert into product_image_uploads(organization_id,product_id,issued_by,object_path,expires_at,
       state,claimed_at,claim_expires_at,consumed_at,cleanup_error_count,cleanup_retry_after)
     values($1,$2,$3,$4, ${opts.expired ? "now() + interval '1 second'" : "now() + interval '3 hours'"},
       $5,
       ${opts.state === "claimed" ? "now()" : "null"},
       ${opts.state === "claimed" ? "now() + interval '2 minutes'" : "null"},
       ${opts.state === "consumed" ? "now()" : "null"},
       $6,
       ${opts.retryAfterPast ? past : "null"})`,
    [org, product, uid(opts.user ?? 1), path, opts.state ?? "pending", opts.errors ?? 0],
  );
  if (opts.expired) {
    // expires_at must exceed created_at (CHECK): backdate both.
    await db.query(
      `update product_image_uploads set created_at = now() - interval '4 hours',
         expires_at = now() - interval '1 hour' where object_path = $1`,
      [path],
    );
  }
  if (opts.withObject !== false) storage.put(path);
  return path;
}
const setCol = (path: string, sql: string) =>
  db.query(`update product_image_uploads set ${sql} where object_path = $1`, [path]);

beforeAll(async () => {
  const f = await financialFixture();
  db = f.db;
  await db.exec("reset role");
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  storage = new FakeStorage();
  seq = 0;
  await db.exec("truncate product_image_uploads; delete from products;");
  for (const [id, org] of [
    [PRODUCT_A, ORG_A],
    [PRODUCT_B, ORG_B],
  ]) {
    await db.query(
      "insert into products(id,organization_id,name_km,name_en,status) values($1,$2,'x','x','ACTIVE')",
      [id, org],
    );
  }
  for (const r of restore) r();
  restore = [];
  const repo = await import("../server/products/repository");
  const st = await import("../server/products/image-storage");
  const lim = await import("../server/rate-limit/limiter");
  const store = await import("../server/rate-limit/store");
  restore.push(
    repo.setProductRepositoryDbForTests(sqlClient(db)),
    st.setProductImageStorageForTests(storage),
    lim.setPrimaryRateLimitStore(new store.MemoryRateLimitStore()),
  );
});

// ══ Migration 050 ═════════════════════════════════════════════════════════════

describe("migration 050 — schema and access", () => {
  it("has no SECURITY DEFINER, pins search_path, and grants execute only to service_role", async () => {
    const sql = readFileSync("supabase/migrations/050_product_image_upload_lifecycle.sql", "utf8");
    expect(/SECURITY\s+DEFINER/i.test(sql.replace(/--.*$/gm, ""))).toBe(false);
    const fns = (
      await db.query(
        `select p.proname, p.prosecdef, p.proconfig,
                has_function_privilege('anon', p.oid, 'execute') as anon_x,
                has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
                has_function_privilege('service_role', p.oid, 'execute') as svc_x
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like '%product_image_upload%'`,
      )
    ).rows;
    expect(fns.length).toBe(5);
    for (const f of fns) {
      expect(f.prosecdef).toBe(false);
      expect(String(f.proconfig)).toContain("search_path=public, pg_temp");
      expect(f.anon_x).toBe(false);
      expect(f.auth_x).toBe(false);
      expect(f.svc_x).toBe(true);
    }
  });

  it("keeps existing 049 rows as pending tickets (upgrade from 049)", async () => {
    const old = new PGlite();
    await old.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;`);
    const names = readdirSync("supabase/migrations")
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort();
    for (const n of names.filter((x) => x < "050")) {
      await old.exec(readFileSync(`supabase/migrations/${n}`, "utf8"));
    }
    const actor = uid(9);
    await old.query("insert into auth.users(id,email) values($1,'u@test.invalid')", [actor]);
    await old.query(
      "insert into organizations(id,legal_name,display_name,slug,created_by) values($1,'A','A','upgrade-a',$2)",
      [ORG_A, actor],
    );
    await old.query(
      "insert into products(id,organization_id,name_km,name_en,status) values($1,$2,'x','x','ACTIVE')",
      [PRODUCT_A, ORG_A],
    );
    const path = buildProductImagePath(ORG_A, PRODUCT_A, objId(1), "image/jpeg");
    await old.query(
      `insert into product_image_uploads(organization_id,product_id,issued_by,object_path,expires_at)
       values($1,$2,$3,$4,now()+interval '3 hours')`,
      [ORG_A, PRODUCT_A, actor, path],
    );
    await old.exec(
      readFileSync("supabase/migrations/050_product_image_upload_lifecycle.sql", "utf8"),
    );
    const r = (await old.query("select state, cleanup_error_count from product_image_uploads"))
      .rows;
    expect(r).toEqual([{ state: "pending", cleanup_error_count: 0 }]);
    await old.close();
  });

  it("rejects an invalid state and a claimed row without a claim window", async () => {
    const path = await seedTicket({});
    await expect(setCol(path, "state = 'bogus'")).rejects.toThrow();
    await expect(setCol(path, "state = 'claimed'")).rejects.toThrow();
  });

  it("still denies anon/authenticated any table access", async () => {
    await db.exec("set role authenticated");
    await expect(db.query("select * from product_image_uploads")).rejects.toThrow();
    await db.exec("reset role; set role anon");
    await expect(db.query("select * from product_image_uploads")).rejects.toThrow();
    await db.exec("reset role");
  });
});

// ══ Ticket state machine (SQL functions) ══════════════════════════════════════

describe("ticket state — atomic claim / finalize", () => {
  const claim = (org: string, product: string, path: string, secs = 120) =>
    db
      .query("select claim_product_image_upload_v1($1,$2,$3,$4) as id", [org, product, path, secs])
      .then((r: { rows: Array<{ id: string | null }> }) => r.rows[0]!.id);
  const finalize = (org: string, product: string, path: string) =>
    db
      .query("select finalize_product_image_upload_v1($1,$2,$3) as prev", [org, product, path])
      .then((r: { rows: Array<{ prev: string | null }> }) => r.rows[0]!.prev);

  it("pending -> claimed -> consumed; product updated in the same step", async () => {
    const path = await seedTicket({});
    expect(await claim(ORG_A, PRODUCT_A, path)).not.toBeNull();
    expect((await ticketOf(path)).state).toBe("claimed");
    expect(await productImage()).toBeNull(); // claim alone never touches the product
    expect(await finalize(ORG_A, PRODUCT_A, path)).toBe(""); // no previous image
    expect((await ticketOf(path)).state).toBe("consumed");
    expect(await productImage()).toBe(path);
  });

  it("a duplicate claim is denied; an expired pending ticket cannot be claimed", async () => {
    const path = await seedTicket({});
    expect(await claim(ORG_A, PRODUCT_A, path)).not.toBeNull();
    expect(await claim(ORG_A, PRODUCT_A, path)).toBeNull();
    const expired = await seedTicket({ expired: true });
    expect(await claim(ORG_A, PRODUCT_A, expired)).toBeNull();
    expect((await ticketOf(expired)).state).toBe("pending");
  });

  it("claim is bound to exact org, product and path", async () => {
    const path = await seedTicket({});
    expect(await claim(ORG_B, PRODUCT_A, path)).toBeNull();
    expect(await claim(ORG_A, PRODUCT_B, path)).toBeNull();
    expect(await claim(ORG_A, PRODUCT_A, path.replace(".jpg", ".png"))).toBeNull();
    expect((await ticketOf(path)).state).toBe("pending");
  });

  it("finalize needs a claim: pending / consumed / missing tickets change nothing", async () => {
    const pending = await seedTicket({});
    expect(await finalize(ORG_A, PRODUCT_A, pending)).toBeNull();
    expect(await productImage()).toBeNull();
    const done = await seedTicket({});
    await claim(ORG_A, PRODUCT_A, done);
    await finalize(ORG_A, PRODUCT_A, done);
    expect(await finalize(ORG_A, PRODUCT_A, done)).toBeNull(); // no replay
  });

  it("finalize is atomic: if the product cannot be updated the ticket is NOT consumed", async () => {
    const path = await seedTicket({});
    await claim(ORG_A, PRODUCT_A, path);
    await db.exec(`
      create function zz_block_products() returns trigger language plpgsql as
        $$ begin raise exception 'blocked'; end $$;
      create trigger zz_block before update on products
        for each row execute function zz_block_products();`);
    try {
      await expect(finalize(ORG_A, PRODUCT_A, path)).rejects.toThrow();
    } finally {
      await db.exec("drop trigger zz_block on products; drop function zz_block_products();");
    }
    expect((await ticketOf(path)).state).toBe("claimed"); // rolled back, not consumed
    expect(await productImage()).toBeNull();
  });

  it("returns the previous image so replace can retire it", async () => {
    const first = await seedTicket({});
    await claim(ORG_A, PRODUCT_A, first);
    await finalize(ORG_A, PRODUCT_A, first);
    const second = await seedTicket({});
    await claim(ORG_A, PRODUCT_A, second);
    expect(await finalize(ORG_A, PRODUCT_A, second)).toBe(first);
    expect(await productImage()).toBe(second);
  });

  it("stale claim on a live ticket is re-claimable (crash recovery); an active claim is not", async () => {
    const path = await seedTicket({});
    await claim(ORG_A, PRODUCT_A, path);
    expect(await claim(ORG_A, PRODUCT_A, path)).toBeNull(); // active
    await setCol(path, `claim_expires_at = ${past}`);
    expect(await claim(ORG_A, PRODUCT_A, path)).not.toBeNull(); // recovered
  });
});

// ══ Cleanup selection (SQL) ═══════════════════════════════════════════════════

describe("cleanup selection", () => {
  const take = (limit = 25, lease = 600) =>
    db
      .query("select * from take_product_image_upload_cleanup_v1($1,$2)", [limit, lease])
      .then((r: { rows: Array<{ object_path: string }> }) => r.rows.map((x) => x.object_path));

  it("takes expired pending tickets; never a live pending ticket", async () => {
    const dead = await seedTicket({ expired: true });
    await seedTicket({});
    expect(await take()).toEqual([dead]);
    expect((await ticketOf(dead)).state).toBe("cleaning");
  });

  it("an ACTIVE claim is excluded even after the ticket's own expiry; a stale claim is taken", async () => {
    const path = await seedTicket({ state: "claimed", expired: true });
    // claimed row keeps its 2-minute window (seed sets it) -> active
    expect(await take()).toEqual([]);
    await setCol(path, `claim_expires_at = ${past}`);
    expect(await take()).toEqual([path]);
  });

  it("consumed rows are never taken; an object a product references is resolved, not handed out", async () => {
    const consumed = await seedTicket({ state: "consumed", expired: true });
    const attached = await seedTicket({ expired: true });
    await db.query("update products set image_path = $1 where id = $2", [attached, PRODUCT_A]);
    expect(await take()).toEqual([]);
    expect((await ticketOf(consumed)).state).toBe("consumed");
    expect((await ticketOf(attached)).state).toBe("consumed");
  });

  it("is bounded per call and processes fewest-failures first (no head-of-line starvation)", async () => {
    const failing: string[] = [];
    for (let i = 0; i < 3; i++)
      failing.push(
        await seedTicket({ expired: true, errors: 4, retryAfterPast: true, state: "pending" }),
      );
    const fresh: string[] = [];
    for (let i = 0; i < 3; i++) fresh.push(await seedTicket({ expired: true }));
    // The failing rows are also the OLDEST by expiry; fresh ones still come first.
    await db.query(
      "update product_image_uploads set expires_at = now() - interval '3 hours', created_at = now() - interval '5 hours' where cleanup_error_count = 4",
    );
    const got = await take(3);
    expect(got.sort()).toEqual([...fresh].sort());
  });

  it("a failed delete backs off (retry_after) and stays unresolved; the lease lapses so a crashed sweep is retried", async () => {
    const path = await seedTicket({ expired: true });
    expect(await take()).toEqual([path]);
    expect(await take()).toEqual([]); // leased to the first sweep
    await db.query("select fail_product_image_upload_cleanup_v1($1::uuid[])", [
      `{${(await ticketOf(path)).id}}`,
    ]);
    const t = await ticketOf(path);
    expect(t.state).toBe("cleaning");
    expect(t.cleanup_error_count).toBe(1);
    expect(await take()).toEqual([]); // backing off
    await setCol(path, `cleanup_retry_after = ${past}`);
    expect(await take()).toEqual([path]); // retried
  });

  it("prunes old consumed rows", async () => {
    const old = await seedTicket({ state: "consumed" });
    await setCol(old, "consumed_at = now() - interval '2 days'");
    const recent = await seedTicket({ state: "consumed" });
    await take();
    expect(await ticketOf(old)).toBeUndefined();
    expect(await ticketOf(recent)).toBeDefined();
  });
});

// ══ Attach vs sweep interleavings (service over SQL) ══════════════════════════

describe("attach vs sweep", () => {
  it("THE Codex race: claimed ticket crosses expiry, sweep runs, attach still wins; new image survives", async () => {
    const old = await ask();
    storage.put(old.path);
    await attach(old.path); // existing image
    const t = await ask();
    storage.put(t.path);

    let release!: () => void;
    storage.inspectGate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (storage.inspectStarted = r));
    const pending = attach(t.path); // 1. claims, then parks inside inspect
    await started;
    await setCol(t.path, `created_at = now() - interval '4 hours', expires_at = ${past}`); // 2. crosses expiry
    const sweep = await (await svc()).sweepExpiredProductImageUploads(); // 3. sweep
    expect(sweep).toEqual({ resolved: 0, failed: 0 }); // 4. active claim: not taken
    expect(storage.objects.has(t.path)).toBe(true);
    storage.inspectGate = null;
    release();
    await pending; // 5. product updated, 6. consumed
    expect(await productImage()).toBe(t.path);
    expect((await ticketOf(t.path)).state).toBe("consumed");
    expect(storage.objects.has(old.path)).toBe(false); // 7. old image retired …
    expect(storage.objects.has(t.path)).toBe(true); // 8. … new image intact
    await (await svc()).sweepExpiredProductImageUploads();
    expect(storage.objects.has(t.path)).toBe(true);
  });

  it("sweep BEFORE claim removes an abandoned expired upload; a later attach fails closed", async () => {
    const t = await ask();
    storage.put(t.path);
    await setCol(t.path, `created_at = now() - interval '4 hours', expires_at = ${past}`);
    await (await svc()).sweepExpiredProductImageUploads();
    expect(storage.objects.has(t.path)).toBe(false);
    await expect(attach(t.path)).rejects.toMatchObject({ statusCode: 400 });
    expect(await productImage()).toBeNull();
  });

  it("sweep AFTER the product reference exists never deletes it, even with a stray unconsumed ticket", async () => {
    const t = await ask();
    storage.put(t.path);
    await attach(t.path);
    await setCol(
      t.path,
      `state = 'pending', consumed_at = null, created_at = now() - interval '4 hours', expires_at = ${past}`,
    );
    await (await svc()).sweepExpiredProductImageUploads();
    expect(storage.objects.has(t.path)).toBe(true);
    expect(await productImage()).toBe(t.path);
    expect((await ticketOf(t.path)).state).toBe("consumed");
  });

  it("abandoned claim: after its window the ticket is recovered — cleaned once expired, re-attachable while live", async () => {
    const live = await ask();
    storage.put(live.path);
    await setCol(live.path, `state='claimed', claimed_at=now(), claim_expires_at=${past}`); // crashed attach
    await attach(live.path); // recoverable: re-claimed and attached
    expect(await productImage()).toBe(live.path);

    const dead = await ask();
    storage.put(dead.path);
    await setCol(
      dead.path,
      `state='claimed', claimed_at=now(), claim_expires_at=${past}, created_at = now() - interval '4 hours', expires_at = ${past}`,
    );
    await (await svc()).sweepExpiredProductImageUploads();
    expect(storage.objects.has(dead.path)).toBe(false);
    expect(await ticketOf(dead.path)).toBeUndefined(); // resolved
    expect(storage.objects.has(live.path)).toBe(true);
  });

  it("a slow attach whose claim lapsed and was swept cannot point the product at a deleted object", async () => {
    const t = await ask();
    storage.put(t.path);
    let release!: () => void;
    storage.inspectGate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (storage.inspectStarted = r));
    const slow = attach(t.path);
    await started;
    await setCol(
      t.path,
      `claim_expires_at = ${past}, created_at = now() - interval '4 hours', expires_at = ${past}`,
    );
    await (await svc()).sweepExpiredProductImageUploads(); // takes the stale claim, deletes object
    expect(storage.objects.has(t.path)).toBe(false);
    storage.inspectGate = null;
    release();
    await expect(slow).rejects.toMatchObject({ statusCode: 400 });
    expect(await productImage()).toBeNull();
  });

  it("concurrent duplicate attach: exactly one succeeds, the other fails safely, object kept", async () => {
    const t = await ask();
    storage.put(t.path);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => attach(t.path)));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ statusCode: 400 });
    }
    expect(await productImage()).toBe(t.path);
    expect(storage.objects.has(t.path)).toBe(true);
    expect((await ticketOf(t.path)).state).toBe("consumed");
  });

  it("sequential replay of a consumed ticket is refused", async () => {
    const t = await ask();
    storage.put(t.path);
    await attach(t.path);
    await expect(attach(t.path)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("invalid content: object deleted and ticket resolved; transient inspect failure releases the claim", async () => {
    const bad = await ask();
    storage.put(bad.path, new Uint8Array([0xff, 0xd8, 0xff]));
    await expect(attach(bad.path)).rejects.toMatchObject({ statusCode: 400 });
    expect(storage.objects.has(bad.path)).toBe(false);
    expect(await ticketOf(bad.path)).toBeUndefined();

    const t = await ask();
    storage.put(t.path);
    const orig = storage.inspect.bind(storage);
    storage.inspect = async () => {
      throw new Error("storage down");
    };
    await expect(attach(t.path)).rejects.toMatchObject({ statusCode: 503 });
    expect((await ticketOf(t.path)).state).toBe("pending"); // retryable, not stuck
    storage.inspect = orig;
    await attach(t.path);
    expect(await productImage()).toBe(t.path);
  });

  it("an invalid object that cannot be deleted stays unresolved (and counted) for the sweep", async () => {
    const bad = await ask();
    storage.put(bad.path, new Uint8Array([0xff, 0xd8, 0xff]));
    storage.failAll = true;
    await expect(attach(bad.path)).rejects.toMatchObject({ statusCode: 400 });
    expect((await ticketOf(bad.path)).state).toBe("pending");
  });
});

// ══ Issuance caps under concurrency ═══════════════════════════════════════════

describe("atomic issuance caps", () => {
  const settle = (ps: Array<Promise<unknown>>) => Promise.allSettled(ps);
  const ok = (r: PromiseSettledResult<unknown>[]) =>
    r.filter((x) => x.status === "fulfilled").length;
  const codes = (r: PromiseSettledResult<unknown>[]) =>
    r
      .filter((x) => x.status === "rejected")
      .map((x) => (x as PromiseRejectedResult).reason.statusCode);

  it("40 simultaneous requests from one member create exactly 30 tickets and 30 signed URLs", async () => {
    const r = await settle(Array.from({ length: 40 }, () => ask(ORG_A, 1)));
    expect(ok(r)).toBe(30);
    expect(new Set(codes(r))).toEqual(new Set([429]));
    expect(codes(r).length).toBe(10);
    expect((await rows()).length).toBe(30);
    expect(storage.signed.length).toBe(30); // refused requests never signed a URL
  });

  it("many members in one org cannot exceed 100 unresolved tickets; another org is unaffected", async () => {
    const wave = [1, 2, 3, 4, 5].flatMap((m) => Array.from({ length: 30 }, () => ask(ORG_A, m)));
    const r = await settle(wave);
    expect(ok(r)).toBe(100);
    expect(new Set(codes(r))).toEqual(new Set([429]));
    expect((await rows(`organization_id = '${ORG_A}'`)).length).toBe(100);
    expect(storage.signed.length).toBe(100);
    // Org B is untouched by A's saturation, even when requested at the same time.
    const b = await settle(Array.from({ length: 5 }, () => ask(ORG_B, 1, PRODUCT_B)));
    expect(ok(b)).toBe(5);
    await expect(ask(ORG_A, 6)).rejects.toMatchObject({ statusCode: 429 });
  });

  it("the durable hourly limiter still applies on top of the backlog cap", async () => {
    const { RATE_LIMITS } = await import("../server/rate-limit/policies");
    expect(RATE_LIMITS.productImageUploadMember.limit).toBe(60);
    for (let wave = 0; wave < 2; wave++) {
      const r = await settle(Array.from({ length: 30 }, () => ask(ORG_A, 1)));
      expect(ok(r)).toBe(30);
      await db.query("delete from product_image_uploads"); // empty backlog: only the limiter is left
    }
    const signedBefore = storage.signed.length;
    await expect(ask(ORG_A, 1)).rejects.toMatchObject({ statusCode: 429 });
    expect((await rows()).length).toBe(0); // refused: no ticket …
    expect(storage.signed.length).toBe(signedBefore); // … and no signed URL
  });

  it("a failed signing releases its ticket so it does not consume backlog", async () => {
    storage.createUpload = async () => {
      throw new Error("sign down");
    };
    for (let i = 0; i < 35; i++) {
      await expect(ask()).rejects.toMatchObject({ statusCode: 503 });
    }
    expect((await rows()).length).toBe(0);
  });
});

// ══ Persistent cleanup failure: hard backlog bound ════════════════════════════

describe("persistent cleanup failure", () => {
  it("expired-but-undeleted tickets keep counting; issuance fails closed at 30 / 100, then resumes", async () => {
    storage.failAll = true;
    // 100 unresolved, ALL already expired: 30 + 30 + 30 + 10 across four members.
    for (const [member, n] of [
      [1, 30],
      [2, 30],
      [3, 30],
      [4, 10],
    ] as const) {
      for (let i = 0; i < n; i++) await seedTicket({ expired: true, user: member });
    }
    const s = await svc();
    for (let round = 0; round < 3; round++) {
      await s.sweepExpiredProductImageUploads(); // every delete fails
      await db.query(
        "update product_image_uploads set cleanup_retry_after = now() - interval '1 minute' where state = 'cleaning'",
      );
    }
    expect((await rows("state <> 'consumed'")).length).toBe(100); // nothing was resolved
    // Member cap (30) and organization cap (100) both hold although every ticket is expired.
    await expect(ask(ORG_A, 1)).rejects.toMatchObject({ statusCode: 429 });
    await expect(ask(ORG_A, 9)).rejects.toMatchObject({ statusCode: 429 });
    expect(storage.signed.length).toBe(0); // no new signed URL while the backlog is full
    // Another organization is unaffected.
    await ask(ORG_B, 1, PRODUCT_B);

    // Storage recovers: cleanup drains the backlog and issuance resumes.
    storage.failAll = false;
    await db.query(
      "update product_image_uploads set cleanup_retry_after = now() - interval '1 minute' where state = 'cleaning'",
    );
    const t = await ask(ORG_A, 9); // its own opportunistic sweep frees 25 slots first
    expect(t.uploadUrl).toContain("storage.test");
    expect((await rows(`organization_id = '${ORG_A}' and state <> 'consumed'`)).length).toBe(76);
  });

  it("the member cap alone (30 expired, undeleted) blocks that member but not a colleague", async () => {
    storage.failAll = true;
    for (let i = 0; i < 30; i++) await seedTicket({ expired: true, user: 1 });
    await expect(ask(ORG_A, 1)).rejects.toMatchObject({ statusCode: 429 });
    expect(storage.signed.length).toBe(0);
    expect((await ask(ORG_A, 2)).uploadUrl).toContain("storage.test"); // org total is only 30
  });

  it("one undeletable row does not block later rows", async () => {
    const stuck: string[] = [];
    for (let i = 0; i < 26; i++) stuck.push(await seedTicket({ expired: true, user: 1 }));
    const later: string[] = [];
    for (let i = 0; i < 4; i++) later.push(await seedTicket({ expired: true, user: 2 }));
    // Make the 26 oldest permanently undeletable.
    await db.query(
      "update product_image_uploads set expires_at = now() - interval '2 hours' where issued_by = $1",
      [uid(1)],
    );
    for (const p of stuck) storage.failPaths.add(p);
    const s = await svc();
    const first = await s.sweepExpiredProductImageUploads(); // batch = 25 oldest, all failing
    expect(first).toEqual({ resolved: 0, failed: 25 });
    const second = await s.sweepExpiredProductImageUploads(); // advances past the failed rows
    expect(second.resolved).toBe(4 + 0);
    for (const p of later) expect(storage.objects.has(p)).toBe(false);
    for (const p of stuck) expect(await ticketOf(p)).toBeDefined(); // still unresolved
    expect((await rows("state <> 'consumed'")).length).toBe(26);
  });

  it("successful cleanup reduces the backlog and the ticket rows", async () => {
    for (let i = 0; i < 5; i++) await seedTicket({ expired: true });
    expect((await rows()).length).toBe(5);
    await (await svc()).sweepExpiredProductImageUploads();
    expect((await rows()).length).toBe(0);
    expect(storage.removed.length).toBe(5);
  });
});

// ══ Regression: the rest of the product-image surface still works over SQL ════

describe("regression over real SQL", () => {
  it("upload -> attach -> replace -> remove", async () => {
    const s = await svc();
    const a = await ask();
    storage.put(a.path);
    expect((await attach(a.path)).imageUrl).toContain("storage.test");
    const b = await ask();
    storage.put(b.path);
    await attach(b.path);
    expect(await productImage()).toBe(b.path);
    expect(storage.objects.has(a.path)).toBe(false);
    await s.removeProductImage(ctxFor(ORG_A, 1), PRODUCT_A);
    expect(await productImage()).toBeNull();
    expect(storage.objects.has(b.path)).toBe(false);
  });

  it("cross-tenant: org A can neither issue for, nor attach, org B's product/object", async () => {
    await expect(ask(ORG_A, 1, PRODUCT_B)).rejects.toMatchObject({ statusCode: 404 });
    const b = await ask(ORG_B, 1, PRODUCT_B);
    storage.put(b.path);
    await expect(attach(b.path, ORG_A, 1, PRODUCT_A)).rejects.toMatchObject({ statusCode: 400 });
    await expect(attach(b.path, ORG_A, 1, PRODUCT_B)).rejects.toMatchObject({ statusCode: 404 });
    expect((await ticketOf(b.path)).state).toBe("pending");
    expect(storage.objects.has(b.path)).toBe(true);
  });
});
