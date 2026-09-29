/**
 * Regression: the Team membership select must name the `user_id` relationship.
 *
 * `memberships` has two foreign keys to `profiles` (user_id, invited_by). A bare
 * `profiles(...)` embed is ambiguous, and PostgREST answers HTTP 300 / PGRST201.
 * Found on a fresh staging project when inviting an email that already had an
 * account (findMembershipByEmail). Every path sharing MEMBERSHIP_SELECT was
 * affected: roster, lookup by id, lookup by email, role update, status update.
 *
 * The fake below reproduces PostgREST's behaviour: a `profiles(` embed without a
 * relationship hint on `memberships` returns PGRST201, and a hint naming
 * invited_by is accepted but would attach the INVITER's identity — which the
 * tests reject, because it would silently show the wrong person.
 *
 * Run: bun test src/tests/team-membership-embed.test.ts
 */
import { afterAll, describe, expect, it, mock } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const MEMBER_ID = "mmmmmmmm-0000-0000-0000-000000000001";
const USER_ID = "uuuuuuuu-0000-0000-0000-000000000001";
const INVITER_ID = "iiiiiiii-0000-0000-0000-000000000001";

type Call = { method: string; args: unknown[] };

const HINT_USER = "profiles!memberships_user_id_fkey(";

/** PostgREST embed resolution for memberships → profiles, as the server does it. */
function resolveProfilesEmbed(select: string): "ambiguous" | "member" | "inviter" | "none" {
  if (/(^|[\s,])profiles!memberships_invited_by_fkey\(/.test(select)) return "inviter";
  if (select.includes(HINT_USER)) return "member";
  if (/(^|[\s,])profiles\(/.test(select)) return "ambiguous";
  return "none";
}

function makeFake() {
  const calls: Call[] = [];
  let table = "";
  let select = "";
  let updating = false;
  const filters: Record<string, unknown> = {};

  const memberRow = (embed: ReturnType<typeof resolveProfilesEmbed>) => ({
    id: MEMBER_ID,
    user_id: USER_ID,
    organization_id: ORG_A,
    role_id: "00000000-0000-0000-0000-000000000004",
    status: "active",
    joined_at: "2026-01-01T00:00:00.000Z",
    invited_by: INVITER_ID,
    // The embed the server would attach: the member's OR the inviter's profile.
    profiles:
      embed === "inviter"
        ? { display_name: "The Inviter", email: "inviter@example.com", phone: null }
        : { display_name: "The Member", email: "member@example.com", phone: null },
    roles: { name: "Cashier", system_role: "CASHIER" },
  });

  function run() {
    if (table === "profiles") {
      return { data: filters.email === "member@example.com" ? { id: USER_ID } : null, error: null };
    }
    const embed = resolveProfilesEmbed(select);
    if (embed === "ambiguous") {
      return {
        data: null,
        error: {
          code: "PGRST201",
          message:
            "Could not embed because more than one relationship was found for 'memberships' and 'profiles'",
        },
      };
    }
    return { data: memberRow(embed), error: null, _list: [memberRow(embed)] };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    from: (...a: unknown[]) => {
      calls.push({ method: "from", args: a });
      table = a[0] as string;
      select = "";
      updating = false;
      for (const k of Object.keys(filters)) delete filters[k];
      return b;
    },
    select: (...a: unknown[]) => {
      calls.push({ method: "select", args: a });
      select = String(a[0]);
      return b;
    },
    update: (...a: unknown[]) => {
      calls.push({ method: "update", args: a });
      updating = true;
      return b;
    },
    eq: (...a: unknown[]) => {
      calls.push({ method: "eq", args: a });
      filters[a[0] as string] = a[1];
      return b;
    },
    in: (...a: unknown[]) => {
      calls.push({ method: "in", args: a });
      return b;
    },
    order: (...a: unknown[]) => {
      calls.push({ method: "order", args: a });
      return b;
    },
    limit: (...a: unknown[]) => {
      calls.push({ method: "limit", args: a });
      return b;
    },
    maybeSingle: async () => {
      calls.push({ method: "maybeSingle", args: [] });
      const r = run();
      return { data: r.data, error: r.error };
    },
    then: (resolve: (v: unknown) => void) => {
      const r = run() as { data: unknown; error: unknown; _list?: unknown[] };
      resolve({ data: r.error ? null : (r._list ?? []), error: r.error });
    },
  };
  return { db: b, calls, isUpdating: () => updating };
}

// mock.module() replaces the module for the rest of the whole `bun test` process, so put the
// real one back when this file is done — otherwise later files see a stub without
// createServerClient etc.
const realSupabaseServer = { ...(await import("@/lib/supabase/server")) };
afterAll(() => {
  mock.module("@/lib/supabase/server", () => realSupabaseServer);
});

async function loadRepository(fake: ReturnType<typeof makeFake>) {
  mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: fake.db }));
  const isolate = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return await import(`../server/team/repository?isolate=${isolate}`);
}

const membershipSelects = (calls: Call[]) =>
  calls.filter((c) => c.method === "select").map((c) => String(c.args[0]));

describe("Team membership select names the member's own relationship", () => {
  it("the fake really rejects the pre-fix select (guards against a vacuous test)", () => {
    expect(resolveProfilesEmbed("*, profiles(display_name, email, phone), roles(name)")).toBe(
      "ambiguous",
    );
    expect(resolveProfilesEmbed(`*, ${HINT_USER}display_name), roles(name)`)).toBe("member");
    expect(resolveProfilesEmbed("*, profiles!memberships_invited_by_fkey(display_name)")).toBe(
      "inviter",
    );
  });

  it("roster, lookup by id, lookup by email, role update and status update all succeed", async () => {
    const fake = makeFake();
    const repo = await loadRepository(fake);

    const roster = await repo.listMemberships(ORG_A);
    expect(roster).toHaveLength(1);
    expect(roster[0].id).toBe(MEMBER_ID);

    const byId = await repo.findMembershipById(ORG_A, MEMBER_ID);
    expect(byId?.id).toBe(MEMBER_ID);

    // The exact step that threw PGRST201 on staging: an invitee who already has an account.
    const byEmail = await repo.findMembershipByEmail(ORG_A, "  Member@Example.com ");
    expect(byEmail?.id).toBe(MEMBER_ID);

    const roleChanged = await repo.updateMembershipRole(
      ORG_A,
      MEMBER_ID,
      "00000000-0000-0000-0000-000000000004",
    );
    expect(roleChanged?.id).toBe(MEMBER_ID);

    const statusChanged = await repo.updateMembershipStatus(ORG_A, MEMBER_ID, "suspended");
    expect(statusChanged?.id).toBe(MEMBER_ID);

    expect(fake.calls.some((c) => c.method === "update")).toBe(true);
  });

  it("every membership select uses memberships_user_id_fkey — never bare profiles(), never invited_by", async () => {
    const fake = makeFake();
    const repo = await loadRepository(fake);
    await repo.listMemberships(ORG_A);
    await repo.findMembershipById(ORG_A, MEMBER_ID);
    await repo.findMembershipByEmail(ORG_A, "member@example.com");
    await repo.updateMembershipRole(ORG_A, MEMBER_ID, "00000000-0000-0000-0000-000000000004");
    await repo.updateMembershipStatus(ORG_A, MEMBER_ID, "active");

    const selects = membershipSelects(fake.calls).filter((s) => s.includes("roles(")); // membership selects
    expect(selects.length).toBe(5);
    for (const s of selects) {
      expect(s).toContain(HINT_USER);
      expect(resolveProfilesEmbed(s)).toBe("member");
      expect(s).not.toContain("invited_by_fkey");
      expect(s).toContain("display_name, email, phone");
    }
  });

  it("the profile returned is the MEMBER's, not the inviter's", async () => {
    const fake = makeFake();
    const repo = await loadRepository(fake);
    const m = await repo.findMembershipById(ORG_A, MEMBER_ID);
    expect(m?.profile.display_name).toBe("The Member");
    expect(m?.profile.email).toBe("member@example.com");
    expect(m?.invited_by).toBe(INVITER_ID); // invited_by stays a plain column
  });

  it("tenant scoping is unchanged: every membership query is filtered by organization_id", async () => {
    const fake = makeFake();
    const repo = await loadRepository(fake);
    await repo.listMemberships(ORG_A);
    await repo.findMembershipById(ORG_A, MEMBER_ID);
    await repo.findMembershipByEmail(ORG_A, "member@example.com");
    await repo.updateMembershipRole(ORG_A, MEMBER_ID, "00000000-0000-0000-0000-000000000004");
    await repo.updateMembershipStatus(ORG_A, MEMBER_ID, "active");

    const orgFilters = fake.calls.filter(
      (c) => c.method === "eq" && c.args[0] === "organization_id" && c.args[1] === ORG_A,
    );
    expect(orgFilters.length).toBe(5);
  });
});

describe("the schema really has the two relationships the hint disambiguates", () => {
  const sql = fs
    .readFileSync(
      path.join(import.meta.dir, "..", "..", "supabase", "migrations", "006_memberships.sql"),
      "utf8",
    )
    .replace(/\r\n/g, "\n")
    .replace(/--.*$/gm, "");

  it("user_id and invited_by both reference profiles(id), with default (unnamed) constraints", () => {
    expect(sql).toMatch(/\buser_id\s+UUID NOT NULL REFERENCES public\.profiles\(id\)/);
    expect(sql).toMatch(/\binvited_by\s+UUID REFERENCES public\.profiles\(id\)/);
    // No explicit CONSTRAINT names, so PostgreSQL names them <table>_<column>_fkey.
    expect(sql).not.toMatch(/CONSTRAINT\s+memberships_(user_id|invited_by)_fkey/);
  });
});
