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
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { conversationPostgrest } from "./helpers/conversation-postgrest";
import {
  effectiveBrowserAuthority,
  migratedThrough060,
  MIGRATION_061,
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

  it("another creator's defaults reaching browser roles are WARNED about, not revoked or hidden", async () => {
    await scenario(
      `CREATE ROLE platform_admin NOLOGIN;
       GRANT CREATE ON SCHEMA public TO platform_admin;
       ALTER DEFAULT PRIVILEGES FOR ROLE platform_admin IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;`,
      async (db) => {
        const r = await apply061(db);
        expect(r.ok).toBe(true);
        expect(r.notices.join("\n")).toMatch(
          /061: roles other than postgres have default privileges[^\n]*platform_admin public\/r: anon SELECT/,
        );
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
