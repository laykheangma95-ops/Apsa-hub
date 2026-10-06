/**
 * Migration 061 — adversarial role graphs, creator boundary and service_role
 * column authority, against a REAL PostgreSQL (PGlite 0.3 = PostgreSQL 17).
 * Spawned by browser-table-authority.test.ts (isolated: mock.module is
 * process-wide). Never touches hosted Supabase.
 *
 * Every scenario starts from a clone of the RESTRICTED baseline (all migrations
 * through 060) and plants one hostile or unusual privilege state, then applies
 * 061. The required outcome is one of:
 *   - 061 ABORTS, naming the authority it refuses to leave in place, and the
 *     whole transaction rolls back (nothing half-applied); or
 *   - 061 succeeds and the effective browser authority is empty, while roles
 *     061 has no business with are left exactly as they were.
 *
 * P1 — browser authority through role membership (any depth, NOINHERIT too),
 *      on listed and unlisted relations, columns and default ACLs.
 * P2 — service_role authority that works only through PUBLIC or column grants:
 *      061 must abort rather than silently break the server. The real
 *      repository listLocationsForOrg() runs as service_role over a local SQL
 *      transport to prove the workflow worked before and still works after an
 *      abort.
 * P2 (review of 0983cf1) — another role that can create the next relation in
 *      public (effective CREATE: direct, PUBLIC, inherited membership) whose
 *      default privileges reach a browser role: the next table/sequence it
 *      creates is proven browser-reachable, 061 must abort atomically, and
 *      creators that cannot reopen the boundary are left untouched.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { conversationPostgrest } from "./helpers/conversation-postgrest";
import {
  effectiveBrowserAuthority,
  migratedThrough060,
  MIGRATION_061,
  pgVersion,
  serviceRoleAuthority,
} from "./helpers/browser-authority-pg";

// The production repository reads through supabaseAdmin; route it to whichever
// clone the current test is using.
let current: PGlite | undefined;
const transport = {
  from: (table: string) => conversationPostgrest(current!).from(table),
  rpc: (name: string, input: Record<string, unknown>) =>
    conversationPostgrest(current!).rpc(name, input),
};
mock.module("../lib/supabase/server", () => ({ supabaseAdmin: transport }));
mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: transport }));
const { listLocationsForOrg } = await import("../server/inventory/repository");

const SQL_061 = readFileSync(`supabase/migrations/${MIGRATION_061}`, "utf8");
const org = "aaaaaaaa-0000-4000-8000-000000000061";
const user = "aaaaaaaa-0000-4000-8000-0000000000e1";
let base: PGlite;
let location = "";

beforeAll(async () => {
  base = await migratedThrough060("restricted");
  await base.query("INSERT INTO auth.users(id,email) VALUES ($1,'roles@test.invalid')", [user]);
  await base.query(
    `INSERT INTO organizations(id,legal_name,display_name,slug,created_by)
     VALUES ($1,'Roles','Roles','roles-061',$2)`,
    [org, user],
  );
  location = (
    await base.query<{ id: string }>(
      "INSERT INTO locations(organization_id,name) VALUES ($1,'Main store') RETURNING id",
      [org],
    )
  ).rows[0]!.id;
  await base.query(
    "INSERT INTO customers(organization_id,display_name,primary_phone) VALUES ($1,'C','+85512000999')",
    [org],
  );
}, 240000);
afterAll(async () => {
  await base.close();
});

/** A fresh clone with `setup` applied; closed after `run`. */
async function scenario(setup: string, run: (db: PGlite) => Promise<void>) {
  const db = (await base.clone()) as PGlite;
  current = db;
  try {
    if (setup) await db.exec(setup);
    await run(db);
  } finally {
    current = undefined;
    await db.close();
  }
}

async function apply061(db: PGlite): Promise<{ ok: boolean; message: string; notices: string[] }> {
  const notices: string[] = [];
  try {
    await db.exec(SQL_061, { onNotice: (n) => notices.push(String(n.message)) });
    return { ok: true, message: "", notices };
  } catch (error) {
    return { ok: false, message: String((error as Error).message ?? error), notices };
  }
}

/** Abort must be atomic: anon still holds the restricted-baseline Dxtm 061 would have revoked. */
async function expectRolledBack(db: PGlite) {
  const r = await db.query<{ h: boolean }>(
    "SELECT has_table_privilege('anon', 'public.customers', 'TRUNCATE') AS h",
  );
  expect(r.rows[0]!.h).toBe(true);
}

async function as<T>(db: PGlite, role: string, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec("RESET ROLE");
  }
}

async function outcome(db: PGlite, sql: string): Promise<string> {
  try {
    await db.query(sql);
    return "ok";
  } catch (error) {
    return String((error as { code?: string }).code ?? error);
  }
}

/** `outcome` for a multi-statement script. */
async function execOutcome(db: PGlite, sql: string): Promise<string> {
  try {
    await db.exec(sql);
    return "ok";
  } catch (error) {
    return String((error as { code?: string }).code ?? error);
  }
}

/**
 * Every ACL 061 could touch — relation and column ACLs in public, public's
 * schema ACL, and every default ACL. An aborted 061 must leave it unchanged.
 */
async function catalogSnapshot(db: PGlite): Promise<string[]> {
  const rows = (
    await db.query<{ x: string }>(
      `SELECT 'rel ' || c.relname || ' ' || coalesce(c.relacl::text, '-') AS x
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
       UNION ALL
       SELECT 'col ' || c.relname || '.' || a.attname || ' ' || a.attacl::text
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND a.attacl IS NOT NULL
       UNION ALL
       SELECT 'schema public ' || coalesce(nspacl::text, '-') FROM pg_namespace WHERE nspname = 'public'
       UNION ALL
       SELECT 'default ' || defaclrole::regrole::text || ' ' || defaclnamespace::text || ' '
              || defaclobjtype::text || ' ' || defaclacl::text
       FROM pg_default_acl`,
    )
  ).rows;
  return rows.map((r) => r.x).sort();
}

/** An unlisted relation stripped of the restricted-default Dxtm, so only what the test grants remains. */
const unlisted = (name: string, ddl = `CREATE TABLE public.${name} (id int, secret text)`) => `
  ${ddl};
  REVOKE ALL ON public.${name} FROM PUBLIC, anon, authenticated;
`;

// ═════════════════════════════════════════════════════════════════════════════

describe("P1 — browser authority inherited through role membership", () => {
  it("inherited customer SELECT + TRUNCATE (authenticated → business_readers) aborts 061", async () => {
    await scenario(
      `CREATE ROLE business_readers NOLOGIN;
       GRANT SELECT, TRUNCATE ON public.customers TO business_readers;
       GRANT business_readers TO authenticated;`,
      async (db) => {
        expect(
          await as(db, "authenticated", () =>
            outcome(db, "SELECT primary_phone FROM public.customers"),
          ),
        ).toBe("ok");
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/061: browser authority remains/);
        expect(r.message).toContain("business_readers SELECT on customers");
        expect(r.message).toContain("business_readers TRUNCATE on customers");
        await expectRolledBack(db);
      },
    );
  });

  it("inherited TRUNCATE works before 061 and aborts it", async () => {
    await scenario(
      `CREATE ROLE truncaters NOLOGIN;
       GRANT TRUNCATE ON public.customer_tag_assignments TO truncaters;
       GRANT truncaters TO anon;`,
      async (db) => {
        expect(
          await as(db, "anon", () => outcome(db, "TRUNCATE public.customer_tag_assignments")),
        ).toBe("ok");
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toContain("TRUNCATE on customer_tag_assignments");
      },
    );
  });

  it("inherited column SELECT on a listed relation aborts 061", async () => {
    await scenario(
      `CREATE ROLE phone_readers NOLOGIN;
       GRANT SELECT (primary_phone) ON public.customers TO phone_readers;
       GRANT phone_readers TO anon;`,
      async (db) => {
        expect(
          await as(db, "anon", () => outcome(db, "SELECT primary_phone FROM public.customers")),
        ).toBe("ok");
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toContain("SELECT on customers.primary_phone");
      },
    );
  });

  it("nested membership (authenticated → mid → deep → business_readers) is followed to any depth", async () => {
    await scenario(
      `CREATE ROLE business_readers NOLOGIN; CREATE ROLE deep NOLOGIN; CREATE ROLE mid NOLOGIN;
       GRANT SELECT ON public.products TO business_readers;
       GRANT business_readers TO deep; GRANT deep TO mid; GRANT mid TO authenticated;`,
      async (db) => {
        const h = await db.query<{ h: boolean }>(
          "SELECT has_table_privilege('authenticated','public.products','SELECT') AS h",
        );
        expect(h.rows[0]!.h).toBe(true);
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toContain("business_readers SELECT on products");
        expect(r.message).toContain("authenticated SELECT on products");
      },
    );
  });

  it("NOINHERIT membership: no inherited privilege, but SET ROLE still reaches it — 061 aborts", async () => {
    const setup = `CREATE ROLE business_readers NOLOGIN;
       GRANT SELECT ON public.customers TO business_readers;
       GRANT business_readers TO authenticated WITH INHERIT FALSE, SET TRUE;`;
    // PGlite cannot return from SET SESSION AUTHORIZATION, so the demonstration
    // runs on its own throwaway clone.
    await scenario(setup, async (db) => {
      const h = await db.query<{ h: boolean }>(
        "SELECT has_table_privilege('authenticated','public.customers','SELECT') AS h",
      );
      expect(h.rows[0]!.h).toBe(false); // not inherited …
      // … but a session that IS authenticated can switch to the role and read.
      await db.exec("SET SESSION AUTHORIZATION authenticated");
      expect(await outcome(db, "SELECT 1 FROM public.customers")).toBe("42501");
      await db.exec("SET ROLE business_readers");
      expect(await outcome(db, "SELECT primary_phone FROM public.customers")).toBe("ok");
    });
    await scenario(setup, async (db) => {
      const r = await apply061(db);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("business_readers SELECT on customers");
    });
  });

  it("a membership with neither INHERIT nor SET still aborts — conservative by design", async () => {
    await scenario(
      `CREATE ROLE business_readers NOLOGIN;
       GRANT SELECT ON public.customers TO business_readers;
       GRANT business_readers TO authenticated WITH INHERIT FALSE, SET FALSE;`,
      async (db) => {
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toContain("business_readers SELECT on customers");
      },
    );
  });

  it("a role NOT reachable from a browser role is left exactly as it was (061 never revokes from it)", async () => {
    await scenario(
      `CREATE ROLE reporting NOLOGIN; GRANT SELECT ON public.customers TO reporting;
       CREATE ROLE authenticator_like NOLOGIN; GRANT authenticated TO authenticator_like;
       GRANT SELECT ON public.orders TO authenticator_like;`,
      async (db) => {
        const r = await apply061(db);
        expect(r).toMatchObject({ ok: true });
        const h = await db.query<{ a: boolean; b: boolean }>(
          `SELECT has_table_privilege('reporting','public.customers','SELECT') AS a,
                  has_table_privilege('authenticator_like','public.orders','SELECT') AS b`,
        );
        expect(h.rows[0]).toEqual({ a: true, b: true });
        expect(await effectiveBrowserAuthority(db)).toEqual([]);
      },
    );
  });
});

describe("P1 — unlisted relations", () => {
  it("A. unlisted table, inherited authenticated SELECT → abort", async () => {
    await scenario(
      `${unlisted("zz_unlisted")}
       CREATE ROLE business_readers NOLOGIN;
       GRANT SELECT ON public.zz_unlisted TO business_readers;
       GRANT business_readers TO authenticated;`,
      async (db) => {
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toContain("business_readers SELECT on zz_unlisted");
      },
    );
  });

  it("B. unlisted table, PUBLIC-equivalent authority (a role every browser role is in, or PUBLIC) → abort", async () => {
    await scenario(
      `${unlisted("zz_unlisted")}
       CREATE ROLE everyone NOLOGIN;
       GRANT ALL ON public.zz_unlisted TO everyone;
       GRANT everyone TO anon, authenticated;`,
      async (db) => {
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toContain("anon DELETE on zz_unlisted");
        expect(r.message).toContain("authenticated INSERT on zz_unlisted");
      },
    );
    await scenario(
      `${unlisted("zz_unlisted")} GRANT SELECT ON public.zz_unlisted TO PUBLIC;`,
      async (db) => {
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toContain("anon SELECT on zz_unlisted");
      },
    );
  });

  it("C. unlisted view, inherited browser authority → abort", async () => {
    await scenario(
      `${unlisted("zz_view", "CREATE VIEW public.zz_view AS SELECT id, primary_phone FROM public.customers")}
       CREATE ROLE view_readers NOLOGIN;
       GRANT SELECT ON public.zz_view TO view_readers;
       GRANT view_readers TO anon;`,
      async (db) => {
        expect(
          await as(db, "anon", () => outcome(db, "SELECT primary_phone FROM public.zz_view")),
        ).toBe("ok");
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toContain("view_readers SELECT on zz_view");
      },
    );
  });

  it("D. unlisted relation, inherited column SELECT → abort", async () => {
    await scenario(
      `${unlisted("zz_unlisted")}
       CREATE ROLE col_readers NOLOGIN;
       GRANT SELECT (secret) ON public.zz_unlisted TO col_readers;
       GRANT col_readers TO authenticated;`,
      async (db) => {
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toContain("SELECT on zz_unlisted.secret");
      },
    );
  });

  it("E. unlisted service-only relation → allowed, and service_role keeps it", async () => {
    await scenario(
      `${unlisted("zz_server_only")}
       GRANT SELECT, INSERT ON public.zz_server_only TO service_role;`,
      async (db) => {
        expect(await apply061(db)).toMatchObject({ ok: true });
        expect(await effectiveBrowserAuthority(db)).toEqual([]);
        expect(
          await as(db, "service_role", () =>
            outcome(db, "INSERT INTO public.zz_server_only VALUES (1,'x')"),
          ),
        ).toBe("ok");
      },
    );
  });
});

describe("P1 — default privileges and the creator boundary", () => {
  for (const scope of ["IN SCHEMA public", ""]) {
    it(`a postgres default (${scope || "global"}) granting a role authenticated is in → abort`, async () => {
      await scenario(
        `CREATE ROLE business_readers NOLOGIN;
         GRANT business_readers TO authenticated;
         ALTER DEFAULT PRIVILEGES FOR ROLE postgres ${scope} GRANT SELECT ON TABLES TO business_readers;`,
        async (db) => {
          const r = await apply061(db);
          expect(r.ok).toBe(false);
          expect(r.message).toMatch(
            /061: default privileges for postgres still give[^\n]*business_readers SELECT/,
          );
        },
      );
    });
  }

  it("a nested-membership default on sequences is caught too", async () => {
    await scenario(
      `CREATE ROLE seq_users NOLOGIN; CREATE ROLE mid NOLOGIN;
       GRANT seq_users TO mid; GRANT mid TO anon;
       ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE ON SEQUENCES TO seq_users;`,
      async (db) => {
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toContain("seq_users USAGE");
      },
    );
  });

  it("a default to a role NO browser role reaches is left alone", async () => {
    await scenario(
      `CREATE ROLE reporting NOLOGIN;
       ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO reporting;`,
      async (db) => {
        expect(await apply061(db)).toMatchObject({ ok: true });
        const d = await db.query<{ acl: string }>(
          "SELECT defaclacl::text AS acl FROM pg_default_acl WHERE defaclrole = 'postgres'::regrole AND defaclobjtype = 'r' AND defaclnamespace = 'public'::regnamespace",
        );
        expect(d.rows[0]!.acl).toContain("reporting=r/postgres");
      },
    );
  });

  it("another creator's defaults reaching browser roles ABORT 061 — not revoked, not merely warned", async () => {
    await scenario(
      `CREATE ROLE platform_admin NOLOGIN;
       GRANT CREATE ON SCHEMA public TO platform_admin;
       ALTER DEFAULT PRIVILEGES FOR ROLE platform_admin IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;`,
      async (db) => {
        const before = await catalogSnapshot(db);
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(
          /061: a role that can create relations in public has default privileges[^\n]*platform_admin \(public tables\): anon SELECT/,
        );
        expect(await catalogSnapshot(db)).toEqual(before);
      },
    );
  });

  it("a relation in public owned by another role (another creator) aborts 061", async () => {
    await scenario(
      `CREATE ROLE platform_admin NOLOGIN;
       CREATE TABLE public.zz_foreign_owned (id int);
       REVOKE ALL ON public.zz_foreign_owned FROM PUBLIC, anon, authenticated;
       ALTER TABLE public.zz_foreign_owned OWNER TO platform_admin;`,
      async (db) => {
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(
          /061: relations in public not owned by postgres[^\n]*zz_foreign_owned \(owner platform_admin\)/,
        );
      },
    );
  });

  it("running as any role other than postgres aborts 061", async () => {
    await scenario(`CREATE ROLE migrator SUPERUSER NOLOGIN;`, async (db) => {
      await db.exec("SET ROLE migrator");
      try {
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/061: must run as postgres[^\n]*running as migrator/);
      } finally {
        await db.exec("RESET ROLE");
      }
    });
  });
});

describe("P2 — service_role authority held only through PUBLIC or column grants", () => {
  it("A. explicit table authority is preserved byte-for-byte, and the real repository works after 061", async () => {
    await scenario("", async (db) => {
      const before = await serviceRoleAuthority(db);
      expect(await apply061(db)).toMatchObject({ ok: true });
      expect(await serviceRoleAuthority(db)).toEqual(before);
      const rows = await as(db, "service_role", () => listLocationsForOrg(org));
      expect(rows.map((r) => r.id)).toEqual([location]);
    });
  });

  it("B. table SELECT held only through PUBLIC: the workflow works before, 061 aborts, the workflow still works", async () => {
    await scenario(
      `REVOKE SELECT ON public.locations FROM service_role;
       GRANT SELECT ON public.locations TO PUBLIC;`,
      async (db) => {
        expect((await as(db, "service_role", () => listLocationsForOrg(org))).length).toBe(1);
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/061: service_role lost authority[^\n]*SELECT locations\b/);
        expect((await as(db, "service_role", () => listLocationsForOrg(org))).length).toBe(1);
      },
    );
  });

  it("C. column SELECT held only through PUBLIC (listLocationsForOrg's exact columns): 061 aborts", async () => {
    await scenario(
      `REVOKE SELECT ON public.locations FROM service_role;
       GRANT SELECT (id, name, status, organization_id) ON public.locations TO PUBLIC;`,
      async (db) => {
        // The real repository works on column grants alone …
        const rows = await as(db, "service_role", () => listLocationsForOrg(org));
        expect(rows).toEqual([{ id: location, name: "Main store", status: "active" }]);
        // … so removing PUBLIC would break it: 061 must refuse.
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/061: service_role lost authority[^\n]*SELECT locations\.id/);
        expect(r.message).toContain("SELECT locations.name");
        expect((await as(db, "service_role", () => listLocationsForOrg(org))).length).toBe(1);
      },
    );
  });

  it("D. column INSERT / UPDATE held only through PUBLIC: 061 aborts", async () => {
    await scenario(
      `REVOKE INSERT, UPDATE ON public.customers FROM service_role;
       GRANT INSERT (organization_id, display_name), UPDATE (display_name) ON public.customers TO PUBLIC;`,
      async (db) => {
        await as(db, "service_role", async () => {
          await db.query(
            "INSERT INTO public.customers(organization_id,display_name) VALUES ($1,'via column')",
            [org],
          );
          await db.query(
            "UPDATE public.customers SET display_name = 'renamed' WHERE display_name = 'via column'",
          );
        });
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        expect(r.message).toContain("INSERT customers.display_name");
        expect(r.message).toContain("UPDATE customers.display_name");
      },
    );
  });

  it("E. payment-ledger writes handed back through PUBLIC (table or column) are removed, as 040 intended", async () => {
    await scenario(
      `GRANT INSERT, UPDATE, DELETE ON public.payments TO PUBLIC;
       GRANT INSERT (amount_minor), UPDATE (amount_minor) ON public.payment_events TO PUBLIC;`,
      async (db) => {
        const h = await db.query<{ h: boolean }>(
          "SELECT has_table_privilege('service_role','public.payments','INSERT') AS h",
        );
        expect(h.rows[0]!.h).toBe(true);
        expect(await apply061(db)).toMatchObject({ ok: true });
        const after = await serviceRoleAuthority(db);
        for (const t of ["payments", "payment_events", "payment_evidence"]) {
          expect(after).toContain(`SELECT ${t}`);
          for (const w of ["INSERT", "UPDATE", "DELETE"]) expect(after).not.toContain(`${w} ${t}`);
          expect(
            after.filter((a) => a.startsWith(`INSERT ${t}.`) || a.startsWith(`UPDATE ${t}.`)),
          ).toEqual([]);
        }
      },
    );
  });

  it("F. authority shared by service_role and a browser role through one role is NOT kept to spare the server", async () => {
    await scenario(
      `CREATE ROLE shared_readers NOLOGIN;
       GRANT SELECT ON public.locations TO shared_readers;
       REVOKE SELECT ON public.locations FROM service_role;
       GRANT shared_readers TO service_role, authenticated;`,
      async (db) => {
        expect((await as(db, "service_role", () => listLocationsForOrg(org))).length).toBe(1);
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        // Refused because a BROWSER role reaches it — the grant is not preserved.
        expect(r.message).toMatch(
          /061: browser authority remains[^\n]*shared_readers SELECT on locations/,
        );
      },
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// P2 (independent review of 0983cf1) — another role that can create the NEXT
// relation in public, whose default privileges hand it to a browser role. On
// 0983cf1 this was only a WARNING: 061 succeeded and the next table/sequence
// that role created was readable/usable by authenticated/anon.
// ═════════════════════════════════════════════════════════════════════════════

/** 061 with the step-6 creator guard removed — the unrepaired behavior. */
function withoutCreatorGuard(): string {
  const lf = SQL_061.replace(/\r\n/g, "\n");
  const weakened = lf.replace(/\n {2}-- 6a\.[\s\S]*?(?=\nEND\n\$\$;)/, "");
  if (weakened === lf) throw new Error("step-6 creator guard not found");
  return weakened;
}

let nextObject = 0;
/**
 * `creator` creates the next table (with one row) and sequence in public, as
 * itself. Returns whether that worked, and whether `reader` can SELECT the
 * table and `seqUser` can nextval the sequence ("ok" or the SQLSTATE).
 */
async function nextObjectsBy(
  db: PGlite,
  creator: string,
  reader = "authenticated",
  seqUser = "anon",
): Promise<{ created: string; read: string; nextval: string }> {
  const n = ++nextObject;
  const created = await as(db, creator, () =>
    execOutcome(
      db,
      `CREATE TABLE public.zz_next_${n} (id int, secret text);
       INSERT INTO public.zz_next_${n} VALUES (1, 'next-object secret');
       CREATE SEQUENCE public.zz_next_seq_${n};`,
    ),
  );
  const read = await as(db, reader, () => outcome(db, `SELECT secret FROM public.zz_next_${n}`));
  const nextval = await as(db, seqUser, () =>
    outcome(db, `SELECT nextval('public.zz_next_seq_${n}')`),
  );
  return { created, read, nextval };
}

/** Applies 061 and expects an atomic abort whose message matches every pattern. */
async function expectCreatorAbort(db: PGlite, ...patterns: RegExp[]) {
  const before = await catalogSnapshot(db);
  const r = await apply061(db);
  expect(r.ok).toBe(false);
  for (const p of patterns) expect(r.message).toMatch(p);
  expect(await catalogSnapshot(db)).toEqual(before);
  await expectRolledBack(db);
}

const CREATOR_ABORT = /061: a role that can create relations in public has default privileges/;

/** The five hostile states the independent review requires to abort 061. */
const HOSTILE_CREATORS: Array<{ name: string; setup: string; creator: string; expect: RegExp[] }> =
  [
    {
      name: "1. active creator + direct authenticated table default",
      setup: `CREATE ROLE reporting_creator NOLOGIN;
         GRANT USAGE, CREATE ON SCHEMA public TO reporting_creator;
         ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;`,
      creator: "reporting_creator",
      expect: [CREATOR_ABORT, /reporting_creator \(public tables\): authenticated SELECT/],
    },
    {
      name: "2. active creator + anon sequence default",
      setup: `CREATE ROLE reporting_creator NOLOGIN;
         GRANT USAGE, CREATE ON SCHEMA public TO reporting_creator;
         ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator IN SCHEMA public GRANT USAGE ON SEQUENCES TO anon;`,
      creator: "reporting_creator",
      expect: [CREATOR_ABORT, /reporting_creator \(public sequences\): anon USAGE/],
    },
    {
      name: "3. active creator + browser-reachable intermediate default (authenticated → business_readers)",
      setup: `CREATE ROLE reporting_creator NOLOGIN; CREATE ROLE business_readers NOLOGIN;
         GRANT USAGE, CREATE ON SCHEMA public TO reporting_creator;
         GRANT business_readers TO authenticated;
         ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator IN SCHEMA public GRANT SELECT ON TABLES TO business_readers;`,
      creator: "reporting_creator",
      expect: [CREATOR_ABORT, /reporting_creator \(public tables\): business_readers SELECT/],
    },
    {
      name: "4. active creator + nested browser-reachable default (authenticated → mid_role → business_readers)",
      setup: `CREATE ROLE reporting_creator NOLOGIN; CREATE ROLE business_readers NOLOGIN; CREATE ROLE mid_role NOLOGIN;
         GRANT USAGE, CREATE ON SCHEMA public TO reporting_creator;
         GRANT business_readers TO mid_role; GRANT mid_role TO authenticated;
         ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator GRANT SELECT ON TABLES TO business_readers;`,
      creator: "reporting_creator",
      expect: [CREATOR_ABORT, /reporting_creator \(global tables\): business_readers SELECT/],
    },
    {
      name: "5. CREATE obtained only through membership (etl → mid → schema_creators)",
      setup: `CREATE ROLE schema_creators NOLOGIN; CREATE ROLE mid NOLOGIN; CREATE ROLE etl NOLOGIN;
         GRANT USAGE, CREATE ON SCHEMA public TO schema_creators;
         GRANT schema_creators TO mid; GRANT mid TO etl;
         ALTER DEFAULT PRIVILEGES FOR ROLE etl IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;
         ALTER DEFAULT PRIVILEGES FOR ROLE etl IN SCHEMA public GRANT USAGE ON SEQUENCES TO anon;`,
      creator: "etl",
      expect: [
        CREATOR_ABORT,
        /etl \(public sequences\): anon USAGE; etl \(public tables\): authenticated SELECT/,
      ],
    },
  ];

describe("P2 — other creators' default privileges reopen browser authority on the next object", () => {
  it("the independent review's exploit: works before 061, and 061 aborts atomically instead of claiming success", async () => {
    const setup = `CREATE ROLE reporting_creator NOLOGIN;
       GRANT USAGE, CREATE ON SCHEMA public TO reporting_creator;
       ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;
       ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator IN SCHEMA public GRANT USAGE ON SEQUENCES TO anon;`;
    // The defaults are real: the creator's next table/sequence is browser-reachable.
    await scenario(setup, async (db) => {
      expect(await nextObjectsBy(db, "reporting_creator")).toEqual({
        created: "ok",
        read: "ok",
        nextval: "ok",
      });
    });
    // Unrepaired 061 (0983cf1 behavior): succeeds, then the boundary reopens.
    await scenario(setup, async (db) => {
      await db.exec(withoutCreatorGuard());
      expect(await effectiveBrowserAuthority(db)).toEqual([]); // "hardened" …
      expect(await nextObjectsBy(db, "reporting_creator")).toEqual({
        created: "ok",
        read: "ok", // … yet authenticated reads the creator's new table
        nextval: "ok", // … and anon uses its new sequence
      });
    });
    // Repaired 061: aborts, names both defaults, and changes nothing.
    await scenario(setup, async (db) => {
      await expectCreatorAbort(
        db,
        CREATOR_ABORT,
        /reporting_creator \(public sequences\): anon USAGE/,
        /reporting_creator \(public tables\): authenticated SELECT/,
      );
    });
  });

  for (const h of HOSTILE_CREATORS) {
    it(`${h.name}: the next object IS browser-reachable, and 061 aborts`, async () => {
      await scenario(h.setup, async (db) => {
        const r = await nextObjectsBy(db, h.creator);
        expect(r.created).toBe("ok");
        expect(r.read === "ok" || r.nextval === "ok").toBe(true);
      });
      await scenario(h.setup, async (db) => {
        await expectCreatorAbort(db, ...h.expect);
      });
    });
  }

  it("a PUBLIC grantee in another creator's default (tables or sequences) aborts", async () => {
    await scenario(
      `CREATE ROLE reporting_creator NOLOGIN;
       GRANT USAGE, CREATE ON SCHEMA public TO reporting_creator;
       ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator IN SCHEMA public GRANT SELECT ON SEQUENCES TO PUBLIC;
       ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator GRANT TRUNCATE ON TABLES TO PUBLIC;`,
      async (db) => {
        await expectCreatorAbort(
          db,
          /reporting_creator \(global tables\): PUBLIC TRUNCATE/,
          /reporting_creator \(public sequences\): PUBLIC SELECT/,
        );
      },
    );
  });

  it("every unsafe table and sequence privilege is named (the whole ALL set, MAINTAIN on PG17)", async () => {
    await scenario(
      `CREATE ROLE reporting_creator NOLOGIN;
       GRANT USAGE, CREATE ON SCHEMA public TO reporting_creator;
       ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
       ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;`,
      async (db) => {
        const r = await apply061(db);
        expect(r.ok).toBe(false);
        const tablePrivs = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES"];
        tablePrivs.push("TRIGGER");
        if ((await pgVersion(db)) >= 170000) tablePrivs.push("MAINTAIN");
        for (const p of tablePrivs)
          expect(r.message).toContain(`reporting_creator (public tables): authenticated ${p}`);
        for (const p of ["USAGE", "SELECT", "UPDATE"])
          expect(r.message).toContain(`reporting_creator (public sequences): authenticated ${p}`);
      },
    );
  });

  it("CREATE through membership is effective authority (no ACL entry names the creator) — 061 aborts", async () => {
    await scenario(
      `CREATE ROLE schema_creators NOLOGIN; CREATE ROLE etl NOLOGIN;
       GRANT USAGE, CREATE ON SCHEMA public TO schema_creators;
       GRANT schema_creators TO etl;
       ALTER DEFAULT PRIVILEGES FOR ROLE etl IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;`,
      async (db) => {
        const acl = await db.query<{ acl: string; can: boolean }>(
          `SELECT nspacl::text AS acl, has_schema_privilege('etl', 'public', 'CREATE') AS can
           FROM pg_namespace WHERE nspname = 'public'`,
        );
        expect(acl.rows[0]!.acl).not.toMatch(/\betl=/); // ACL text alone would miss it …
        expect(acl.rows[0]!.can).toBe(true); // … PostgreSQL says etl can create
        await expectCreatorAbort(db, /etl \(public tables\): authenticated SELECT/);
      },
    );
  });

  it("reverse membership grants no CREATE: the role a creator belongs to is not a creator — 061 succeeds", async () => {
    await scenario(
      `CREATE ROLE defaults_holder NOLOGIN; CREATE ROLE schema_creator NOLOGIN;
       GRANT USAGE, CREATE ON SCHEMA public TO schema_creator;
       GRANT defaults_holder TO schema_creator;
       ALTER DEFAULT PRIVILEGES FOR ROLE defaults_holder IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;`,
      async (db) => {
        const holderDefaults = async () =>
          (
            await db.query<{ acl: string }>(
              "SELECT defaclacl::text AS acl FROM pg_default_acl WHERE defaclrole = 'defaults_holder'::regrole",
            )
          ).rows;
        const before = await holderDefaults();
        expect(await apply061(db)).toMatchObject({ ok: true });
        // defaults_holder cannot create in public, so its defaults never apply there …
        expect(
          await as(db, "defaults_holder", () =>
            outcome(db, "CREATE TABLE public.zz_holder (id int)"),
          ),
        ).toBe("42501");
        // … and what its member creates carries the MEMBER's (empty) defaults.
        expect(await nextObjectsBy(db, "schema_creator")).toEqual({
          created: "ok",
          read: "42501",
          nextval: "42501",
        });
        expect(await holderDefaults()).toEqual(before); // left exactly as it was
      },
    );
  });

  it("SET-only membership (no INHERIT) in a creator is not creator authority for the member itself — 061 succeeds", async () => {
    await scenario(
      `CREATE ROLE schema_creator NOLOGIN; CREATE ROLE switcher NOLOGIN;
       GRANT USAGE, CREATE ON SCHEMA public TO schema_creator;
       GRANT schema_creator TO switcher WITH INHERIT FALSE, SET TRUE;
       ALTER DEFAULT PRIVILEGES FOR ROLE switcher IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;`,
      async (db) => {
        expect(await apply061(db)).toMatchObject({ ok: true });
        // As itself, switcher cannot create in public …
        expect(
          await as(db, "switcher", () => outcome(db, "CREATE TABLE public.zz_switch (id int)")),
        ).toBe("42501");
        // … after SET ROLE the creator owns the object, and ITS defaults (none) apply.
        expect(await nextObjectsBy(db, "schema_creator")).toEqual({
          created: "ok",
          read: "42501",
          nextval: "42501",
        });
      },
    );
  });
});

describe("P2 — CREATE ON SCHEMA public through PUBLIC or a browser role", () => {
  it("PUBLIC CREATE turns a role with no CREATE grant into a creator — its browser defaults abort 061", async () => {
    const defaults = `CREATE ROLE analyst NOLOGIN;
       ALTER DEFAULT PRIVILEGES FOR ROLE analyst IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;`;
    // Without PUBLIC CREATE, analyst cannot create in public: harmless, 061 succeeds.
    await scenario(defaults, async (db) => {
      expect(await apply061(db)).toMatchObject({ ok: true });
    });
    // With it, analyst's next table is authenticated-readable, and 061 must abort.
    const setup = `${defaults} GRANT CREATE ON SCHEMA public TO PUBLIC;`;
    await scenario(setup, async (db) => {
      expect((await nextObjectsBy(db, "analyst")).read).toBe("ok");
    });
    await scenario(setup, async (db) => {
      await expectCreatorAbort(
        db,
        CREATOR_ABORT,
        /analyst \(public tables\): authenticated SELECT/,
      );
    });
  });

  it("PUBLIC CREATE makes the browser roles creators themselves — 061 aborts even with no unsafe defaults", async () => {
    await scenario("GRANT CREATE ON SCHEMA public TO PUBLIC;", async (db) => {
      expect(
        await as(db, "anon", () => outcome(db, "CREATE TABLE public.zz_anon_owned (id int)")),
      ).toBe("ok");
    });
    await scenario("GRANT CREATE ON SCHEMA public TO PUBLIC;", async (db) => {
      await expectCreatorAbort(
        db,
        /061: browser-reachable roles can create relations in public[^\n]*: anon, authenticated\./,
      );
    });
  });

  it("CREATE reaching a browser role through membership (authenticated → business_creators) aborts 061", async () => {
    await scenario(
      `CREATE ROLE business_creators NOLOGIN;
       GRANT USAGE, CREATE ON SCHEMA public TO business_creators;
       GRANT business_creators TO authenticated;`,
      async (db) => {
        await expectCreatorAbort(
          db,
          /061: browser-reachable roles can create relations in public[^\n]*authenticated, business_creators/,
        );
      },
    );
  });
});

describe("P2 — creators 061 must NOT refuse (and must not touch)", () => {
  /** Default ACL rows of every role except postgres — 061 must never change them. */
  const otherDefaults = async (db: PGlite) =>
    (
      await db.query<{ x: string }>(
        `SELECT defaclrole::regrole::text || ' ' || defaclnamespace::text || ' '
                || defaclobjtype::text || ' ' || defaclacl::text AS x
         FROM pg_default_acl WHERE defaclrole <> 'postgres'::regrole ORDER BY 1`,
      )
    ).rows.map((r) => r.x);

  it("A. a role with browser defaults that cannot create in public", async () => {
    await scenario(
      `CREATE ROLE dormant NOLOGIN;
       ALTER DEFAULT PRIVILEGES FOR ROLE dormant IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
       ALTER DEFAULT PRIVILEGES FOR ROLE dormant GRANT ALL ON SEQUENCES TO PUBLIC;`,
      async (db) => {
        const before = await otherDefaults(db);
        expect(before.length).toBe(2);
        expect(await apply061(db)).toMatchObject({ ok: true });
        expect(await otherDefaults(db)).toEqual(before);
        expect(
          await as(db, "dormant", () => outcome(db, "CREATE TABLE public.zz_dormant (id int)")),
        ).toBe("42501");
        expect(await effectiveBrowserAuthority(db)).toEqual([]);
      },
    );
  });

  it("B. a creator with no browser-reaching defaults (server-only defaults)", async () => {
    await scenario(
      `CREATE ROLE etl_server NOLOGIN;
       GRANT USAGE, CREATE ON SCHEMA public TO etl_server;
       ALTER DEFAULT PRIVILEGES FOR ROLE etl_server IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO service_role;`,
      async (db) => {
        const before = await otherDefaults(db);
        expect(await apply061(db)).toMatchObject({ ok: true });
        expect(await otherDefaults(db)).toEqual(before);
        expect(await nextObjectsBy(db, "etl_server")).toEqual({
          created: "ok",
          read: "42501",
          nextval: "42501",
        });
        expect((await nextObjectsBy(db, "etl_server", "service_role", "authenticated")).read).toBe(
          "ok",
        );
      },
    );
  });

  it("C. a creator whose defaults reach only an unreachable reporting role", async () => {
    await scenario(
      `CREATE ROLE reporting_creator NOLOGIN; CREATE ROLE reporting NOLOGIN;
       CREATE ROLE authenticator_like NOLOGIN;
       GRANT authenticated TO authenticator_like; GRANT reporting TO authenticator_like;
       GRANT USAGE, CREATE ON SCHEMA public TO reporting_creator;
       ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator IN SCHEMA public GRANT SELECT ON TABLES TO reporting;
       ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator GRANT USAGE ON SEQUENCES TO reporting;`,
      async (db) => {
        const before = await otherDefaults(db);
        expect(await apply061(db)).toMatchObject({ ok: true });
        expect(await otherDefaults(db)).toEqual(before);
        expect(await nextObjectsBy(db, "reporting_creator")).toEqual({
          created: "ok",
          read: "42501",
          nextval: "42501",
        });
        expect(await nextObjectsBy(db, "reporting_creator", "reporting", "reporting")).toEqual({
          created: "ok",
          read: "ok",
          nextval: "ok",
        });
      },
    );
  });

  it("D. a creator's browser defaults scoped to ANOTHER schema cannot affect public", async () => {
    await scenario(
      `CREATE ROLE reporting_creator NOLOGIN;
       CREATE SCHEMA reports; GRANT USAGE ON SCHEMA reports TO anon, authenticated;
       GRANT USAGE, CREATE ON SCHEMA reports, public TO reporting_creator;
       ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator IN SCHEMA reports GRANT SELECT ON TABLES TO authenticated;
       ALTER DEFAULT PRIVILEGES FOR ROLE reporting_creator IN SCHEMA reports GRANT USAGE ON SEQUENCES TO anon;`,
      async (db) => {
        const before = await otherDefaults(db);
        expect(await apply061(db)).toMatchObject({ ok: true });
        expect(await otherDefaults(db)).toEqual(before);
        expect(await nextObjectsBy(db, "reporting_creator")).toEqual({
          created: "ok",
          read: "42501",
          nextval: "42501",
        });
        // The defaults are real — just not in public.
        expect(
          await as(db, "reporting_creator", () =>
            execOutcome(
              db,
              "CREATE TABLE reports.zz_report (id int); CREATE SEQUENCE reports.zz_rseq",
            ),
          ),
        ).toBe("ok");
        expect(
          await as(db, "authenticated", () => outcome(db, "SELECT * FROM reports.zz_report")),
        ).toBe("ok");
        expect(await as(db, "anon", () => outcome(db, "SELECT nextval('reports.zz_rseq')"))).toBe(
          "ok",
        );
      },
    );
  });

  it("postgres default hardening still closes postgres-created future tables/sequences, alongside a safe creator", async () => {
    await scenario(
      "CREATE ROLE etl_server NOLOGIN; GRANT USAGE, CREATE ON SCHEMA public TO etl_server;",
      async (db) => {
        expect(await apply061(db)).toMatchObject({ ok: true });
        expect(await nextObjectsBy(db, "postgres")).toEqual({
          created: "ok",
          read: "42501",
          nextval: "42501",
        });
        expect(await effectiveBrowserAuthority(db)).toEqual([]);
        const d = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
           WHERE d.defaclrole = 'postgres'::regrole AND d.defaclobjtype IN ('r','S')
             AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole))`,
        );
        expect(d.rows[0]!.n).toBe(0);
      },
    );
  });

  it("service_role table/column/sequence authority is unchanged when other creators are present", async () => {
    await scenario(
      `CREATE ROLE etl_server NOLOGIN; GRANT USAGE, CREATE ON SCHEMA public TO etl_server;
       ALTER DEFAULT PRIVILEGES FOR ROLE etl_server IN SCHEMA public GRANT SELECT ON TABLES TO service_role;`,
      async (db) => {
        const before = await serviceRoleAuthority(db);
        expect(await apply061(db)).toMatchObject({ ok: true });
        expect(await serviceRoleAuthority(db)).toEqual(before);
        expect((await as(db, "service_role", () => listLocationsForOrg(org))).length).toBe(1);
      },
    );
  });
});

describe("negative proof — without the step-6 creator guard every hostile creator slips through", () => {
  for (const h of HOSTILE_CREATORS) {
    it(`${h.name}: guard removed → 061 succeeds and the next object is browser-reachable`, async () => {
      await scenario(h.setup, async (db) => {
        await db.exec(withoutCreatorGuard());
        expect(await effectiveBrowserAuthority(db)).toEqual([]);
        const r = await nextObjectsBy(db, h.creator);
        expect(r.created).toBe("ok");
        expect(r.read === "ok" || r.nextval === "ok").toBe(true);
      });
    });
  }
});
