/**
 * Independent probe of PostgREST's db-max-rows on EMBEDDED arrays, for the
 * finding PR #126 reports against src/server/auth/membership.ts.
 *
 *   bun run embed-probe.ts <PR #126 checkout> <output json>
 *
 * For each cap it provisions the checkout's own throwaway database and
 * PostgREST (scripts/lib/local-postgrest.ts, loopback only), gives one user an
 * active membership per system role, and reads that membership through
 * PostgREST with membership.ts's exact select. It records the role's
 * permission count by plain SQL next to the number of keys the embed returned.
 * It reports; it does not decide. Exits non-zero only if the probe itself fails.
 */
import { SQL } from "bun";
import { writeFileSync } from "node:fs";
import path from "node:path";

const [checkout, output] = process.argv.slice(2);
const adminUrl = process.env["APSA_TEST_PG_URL"];
const bin = process.env["APSA_TEST_POSTGREST_BIN"];
if (!checkout || !output || !adminUrl || !bin) {
  console.error(
    "usage: embed-probe.ts <checkout> <output>; needs APSA_TEST_PG_URL and APSA_TEST_POSTGREST_BIN",
  );
  process.exit(2);
}

const { provision } = (await import(path.resolve(checkout, "scripts/lib/local-postgrest.ts"))) as {
  provision: (
    adminUrl: string,
    bin: string,
    cap: number,
  ) => Promise<{
    databaseUrl: string;
    postgrestUrl: string;
    token: string;
    stop: () => Promise<void>;
  }>;
};

// src/server/auth/membership.ts MEMBERSHIP_CONTEXT_SELECT at f42c4ff.
const SELECT = "*, role:roles(*, role_permissions(permission:permissions(key)))";
const CAPS = [40, 150, 1000];
const ROLES = ["Owner", "Manager", "Cashier"];

const rows: Record<string, unknown>[] = [];
for (const cap of CAPS) {
  const target = await provision(adminUrl, bin, cap);
  const sql = new SQL({ url: target.databaseUrl, max: 2 });
  try {
    for (const role of ROLES) {
      const user = crypto.randomUUID();
      const org = crypto.randomUUID();
      await sql`insert into auth.users(id,email) values(${user}, ${`${user}@test.invalid`})`;
      await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
                values(${org}, 'Embed probe', 'Embed probe', ${`probe-${org}`}, ${user})`;
      const roleId = (
        (await sql`select id from roles where organization_id is null and name = ${role}`) as {
          id: string;
        }[]
      )[0]!.id;
      await sql`insert into memberships(user_id,organization_id,role_id,status)
                values(${user}, ${org}, ${roleId}, 'active')`;
      const inSql = (
        (await sql`select count(*)::int as n from role_permissions where role_id = ${roleId}`) as {
          n: number;
        }[]
      )[0]!.n;
      const response = await fetch(
        `${target.postgrestUrl}/memberships?select=${encodeURIComponent(SELECT)}&user_id=eq.${user}`,
        { headers: { Authorization: `Bearer ${target.token}` } },
      );
      const body = (await response.json()) as {
        role: { role_permissions: { permission: { key: string } | null }[] };
      }[];
      const embedded = body[0]?.role.role_permissions ?? [];
      const keys = new Set(embedded.map((entry) => entry.permission?.key).filter(Boolean));
      rows.push({
        cap,
        role,
        http: response.status,
        permissionsInSql: inSql,
        embeddedRows: embedded.length,
        distinctKeys: keys.size,
        truncated: embedded.length < inSql,
        hasProductsRead: keys.has("products.read"),
        hasProductsViewCost: keys.has("products.view_cost"),
      });
    }
  } finally {
    await sql.close();
    await target.stop();
  }
}

writeFileSync(
  output,
  JSON.stringify({ select: SELECT, postgrest: bin, caps: CAPS, rows }, null, 2),
);
console.table(rows);
