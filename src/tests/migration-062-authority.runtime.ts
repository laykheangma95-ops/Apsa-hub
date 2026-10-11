/**
 * Migration 062 under ADVERSE privilege configurations (PR #121 re-review,
 * finding 3) — PGlite = PostgreSQL 17, every migration, never a hosted project.
 *
 * Baseline: Supabase's default function grants (EXECUTE on every new function
 * to anon, authenticated and service_role) and the permissive table defaults,
 * migrations 001–060, then 061. Each case then plants ONE hostile privilege
 * configuration an environment might carry — a PUBLIC grant, a direct grant,
 * a grant inherited through a role, a SET-only role membership, a rogue
 * overload of a retired or an entry-point name, a wrong owner, default
 * privileges for an extra role, CREATE on schema public — and applies 062.
 *
 * Required: 062 either ABORTS (nothing applied) or leaves NO unsafe effective
 * authority:
 *   - no browser-reachable role (anon, authenticated, and every role either is
 *     a member of, at any depth, by any edge — SET-only included) can execute
 *     any financial RPC, legacy or current, in any schema, any overload;
 *   - no role the server can reach (service_role and its memberships) can
 *     execute a legacy / internal financial function, in any overload;
 *   - service_role can execute exactly the financial entry points, and those
 *     entry points still reach the internals they call;
 *   - no browser-reachable role can CREATE in schema public (no overloads can
 *     be planted after the fact).
 *
 * The family lists below are this test's own, written independently of 062.
 *
 * Run through src/tests/migration-062-authority.test.ts (own process).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  effectiveBrowserAuthority,
  migratedThrough060,
  MIGRATION_061,
  serviceRoleAuthority,
} from "./helpers/browser-authority-pg";

const SQL_061 = readFileSync(`supabase/migrations/${MIGRATION_061}`, "utf8");
const SQL_062 = readFileSync(
  "supabase/migrations/062_financial_replay_refund_audit_atomicity.sql",
  "utf8",
);

/** Legacy and internal financial functions: callable by their owner (and definer callers) only. */
const INTERNAL = [
  "refund_payment_v1",
  "reverse_payment_v1",
  "correct_payment_v1",
  "record_payment_before_order_v1",
  "verify_payment_before_order_v1",
  "reverse_payment_before_order_v1",
  "refund_payment_before_order_v1",
  "lock_payment_order",
  "sync_order_payment_state",
  "payment_replay_matches_v1",
  "payment_request_digest_v1",
  "transition_order_before_payment_authority_v1",
];
/** Financial entry points: the server role only, one signature each. */
const ENTRY = [
  "record_payment_v1",
  "record_payment_v2",
  "verify_payment_v1",
  "attach_payment_evidence_v1",
  "refund_payment_v2",
  "reverse_payment_v2",
  "correct_payment_v2",
];

/** Every role reachable from `seeds` through pg_auth_members — any edge, any depth. */
async function reachable(pg: PGlite, seeds: string[]): Promise<string[]> {
  const edges = (
    await pg.query<{ member: string; role: string }>(
      `SELECT m.member::regrole::text AS member, m.roleid::regrole::text AS role FROM pg_auth_members m`,
    )
  ).rows;
  const reached = new Set(seeds);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of edges) {
      if (reached.has(e.member) && !reached.has(e.role)) {
        reached.add(e.role);
        grew = true;
      }
    }
  }
  return [...reached];
}

/** Every unsafe authority over the financial families, as readable lines. Empty = safe. */
async function violations(pg: PGlite): Promise<string[]> {
  const browser = await reachable(pg, ["anon", "authenticated"]);
  const serverRoles = await reachable(pg, ["service_role"]);
  const fns = (
    await pg.query<{ sig: string; name: string; oid: number; owner: string }>(
      `SELECT p.oid::regprocedure::text AS sig, p.proname AS name, p.oid::int AS oid,
              pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND p.proname = ANY($1)`,
      [[...INTERNAL, ...ENTRY]],
    )
  ).rows;
  const out: string[] = [];
  const can = async (role: string, oid: number) =>
    (
      await pg.query<{ ok: boolean }>(
        `SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS ok`,
        [role, oid],
      )
    ).rows[0]!.ok;
  for (const fn of fns) {
    const internal = INTERNAL.includes(fn.name);
    for (const role of browser) {
      if (role === fn.owner || (await can(role, fn.oid))) out.push(`browser ${role} → ${fn.sig}`);
    }
    if (internal) {
      for (const role of serverRoles) {
        if (role === fn.owner || (await can(role, fn.oid))) out.push(`server ${role} → ${fn.sig}`);
      }
    }
  }
  const publicCreate = await pg.query<{ role: string }>(
    `SELECT r AS role FROM unnest($1::text[]) r WHERE has_schema_privilege(r, 'public', 'CREATE')`,
    [browser],
  );
  for (const row of publicCreate.rows) out.push(`browser ${row.role} → CREATE ON SCHEMA public`);
  return out.sort();
}

/** The financial entry points that exist, one line per function. */
async function entryPoints(pg: PGlite) {
  return (
    await pg.query<{ sig: string; svc: boolean }>(
      `SELECT p.oid::regprocedure::text AS sig,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
         FROM pg_proc p WHERE p.proname = ANY($1) ORDER BY 1`,
      [ENTRY],
    )
  ).rows;
}

let base: PGlite;
beforeAll(async () => {
  base = await migratedThrough060("permissive");
  await base.exec(SQL_061);
}, 180000);
afterAll(async () => {
  await base.close();
});

/** A clone of the 061 baseline with `setup` planted, then 062: "applied" or the abort message. */
async function plantAndMigrate(setup: string) {
  const pg = (await base.clone()) as PGlite;
  if (setup) await pg.exec(setup);
  let outcome = "applied";
  try {
    await pg.exec(SQL_062);
  } catch (error) {
    outcome = `aborted: ${String((error as Error).message ?? error).slice(0, 160)}`;
  }
  return { pg, outcome };
}

const CASES: { name: string; setup: string; mustAbort?: boolean }[] = [
  { name: "clean Supabase-default baseline", setup: "" },
  {
    name: "PUBLIC granted EXECUTE on a pre-authority refund body",
    setup: `GRANT EXECUTE ON FUNCTION public.refund_payment_before_order_v1(uuid,uuid,uuid,bigint,text) TO PUBLIC;`,
  },
  {
    name: "anon granted EXECUTE directly on a pre-authority verification body",
    setup: `GRANT EXECUTE ON FUNCTION public.verify_payment_before_order_v1(uuid,uuid,uuid,text,text,text,jsonb) TO anon;`,
  },
  {
    name: "service_role inherits EXECUTE on a pre-authority reversal body through a role",
    setup: `CREATE ROLE legacy_exec NOLOGIN;
      GRANT EXECUTE ON FUNCTION public.reverse_payment_before_order_v1(uuid,uuid,uuid,text) TO legacy_exec;
      GRANT legacy_exec TO service_role;`,
  },
  {
    name: "authenticated holds a SET-only membership in a role that can sync order payment state",
    setup: `CREATE ROLE legacy_set NOLOGIN;
      GRANT EXECUTE ON FUNCTION public.sync_order_payment_state(uuid,uuid,uuid,text) TO legacy_set;
      GRANT legacy_set TO authenticated WITH INHERIT FALSE, SET TRUE;`,
  },
  {
    name: "a rogue 5-argument refund_payment_v1 overload, executable by the server",
    setup: `CREATE FUNCTION public.refund_payment_v1(p_organization_id uuid, p_payment_id uuid, p_actor uuid,
        p_amount_minor bigint, p_reason text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
        SET search_path = public AS $$
        SELECT public.refund_payment_before_order_v1(p_organization_id, p_payment_id, p_actor, p_amount_minor, p_reason) $$;
      GRANT EXECUTE ON FUNCTION public.refund_payment_v1(uuid,uuid,uuid,bigint,text) TO service_role, authenticated;`,
  },
  {
    name: "a rogue refund_payment_v2 overload planted before 062",
    setup: `CREATE FUNCTION public.refund_payment_v2(p_payment_id uuid) RETURNS jsonb LANGUAGE sql
        AS $$ SELECT jsonb_build_object('status', 'success') $$;
      GRANT EXECUTE ON FUNCTION public.refund_payment_v2(uuid) TO anon;`,
    mustAbort: true,
  },
  {
    name: "browser roles can CREATE in schema public",
    setup: `GRANT CREATE ON SCHEMA public TO anon, authenticated;`,
  },
  {
    name: "default privileges grant EXECUTE on new functions to an extra role",
    setup: `CREATE ROLE reporting NOLOGIN;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO reporting;
      GRANT reporting TO authenticated;`,
  },
  {
    name: "a legacy refund body owned by a browser role",
    setup: `ALTER FUNCTION public.refund_payment_before_order_v1(uuid,uuid,uuid,bigint,text) OWNER TO authenticated;`,
    mustAbort: true,
  },
  {
    name: "service_role is a member of the role that owns a legacy reversal body",
    setup: `CREATE ROLE fn_owner NOLOGIN;
      ALTER FUNCTION public.reverse_payment_before_order_v1(uuid,uuid,uuid,text) OWNER TO fn_owner;
      GRANT fn_owner TO service_role;`,
    mustAbort: true,
  },
  {
    name: "a legacy function name planted in another schema",
    setup: `CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE FUNCTION extensions.correct_payment_v1(uuid) RETURNS jsonb LANGUAGE sql
        AS $$ SELECT '{}'::jsonb $$;
      GRANT USAGE ON SCHEMA extensions TO service_role;
      GRANT EXECUTE ON FUNCTION extensions.correct_payment_v1(uuid) TO service_role;`,
  },
];

describe("migration 062 fails closed or removes unsafe financial authority", () => {
  for (const c of CASES) {
    it(
      c.name,
      async () => {
        const { pg, outcome } = await plantAndMigrate(c.setup);
        try {
          const found = outcome === "applied" ? await violations(pg) : [];
          console.log(
            `[evidence] ${c.name}: ${outcome}${found.length ? ` UNSAFE=[${found.join("; ")}]` : ""}`,
          );
          if (c.mustAbort) {
            expect(outcome).toStartWith("aborted");
            return;
          }
          // Either refused outright, or applied with nothing unsafe left behind.
          if (outcome !== "applied") {
            expect(outcome).toStartWith("aborted");
            return;
          }
          expect(found).toEqual([]);
          // …and the server can still run every entry point, each exactly once.
          const entries = await entryPoints(pg);
          expect(entries.map((e) => e.sig.replace(/\(.*$/, "")).sort()).toEqual([...ENTRY].sort());
          expect(entries.every((e) => e.svc)).toBe(true);
        } finally {
          await pg.close();
        }
      },
      120000,
    );
  }

  it("062 keeps every 061 guarantee: browser roles still hold no table authority; service_role's table authority is unchanged", async () => {
    const before = (await base.clone()) as PGlite;
    try {
      const serverTablesBefore = await serviceRoleAuthority(before);
      await before.exec(SQL_062);
      expect(await effectiveBrowserAuthority(before)).toEqual([]);
      expect(await serviceRoleAuthority(before)).toEqual(serverTablesBefore);
    } finally {
      await before.close();
    }
  }, 120000);

  it("the real abort path leaves nothing of 062 behind (one transaction)", async () => {
    const { pg, outcome } = await plantAndMigrate(
      `ALTER FUNCTION public.refund_payment_before_order_v1(uuid,uuid,uuid,bigint,text) OWNER TO authenticated;`,
    );
    try {
      expect(outcome).toStartWith("aborted");
      const created = await pg.query(
        `SELECT 1 FROM pg_proc WHERE proname IN ('record_payment_v2','refund_payment_v2','reverse_payment_v2','correct_payment_v2')`,
      );
      expect(created.rows).toHaveLength(0);
    } finally {
      await pg.close();
    }
  }, 120000);

  it("a browser role really cannot call a legacy body after 062 — even after SET ROLE through its memberships", async () => {
    const { pg, outcome } = await plantAndMigrate(
      `CREATE ROLE legacy_set NOLOGIN;
       GRANT EXECUTE ON FUNCTION public.refund_payment_before_order_v1(uuid,uuid,uuid,bigint,text) TO legacy_set, PUBLIC;
       GRANT legacy_set TO authenticated WITH INHERIT FALSE, SET TRUE;`,
    );
    try {
      expect(outcome).toBe("applied");
      const attempt = async (sql: string) => {
        try {
          await pg.exec(sql);
          return "executed";
        } catch (error) {
          return (error as { code?: string }).code ?? "error";
        } finally {
          await pg.exec("RESET ROLE");
        }
      };
      const call =
        "SELECT public.refund_payment_before_order_v1(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,'x')";
      expect(await attempt(`SET ROLE anon; ${call}`)).toBe("42501");
      expect(await attempt(`SET ROLE authenticated; ${call}`)).toBe("42501");
      expect(await attempt(`SET ROLE authenticated; SET ROLE legacy_set; ${call}`)).toBe("42501");
      expect(await attempt(`SET ROLE service_role; ${call}`)).toBe("42501");
    } finally {
      await pg.close();
    }
  }, 120000);
});
