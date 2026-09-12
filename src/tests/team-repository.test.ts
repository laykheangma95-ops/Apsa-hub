/**
 * Team repository query-safety tests — src/server/team/repository.ts.
 *
 * Deliberately a SEPARATE file from team-domain.test.ts: every test there
 * mocks the whole repository module (`mock.module("@/server/team/repository", ...)`)
 * so service.ts never touches the real repository.ts. This file does the
 * opposite — it imports the REAL repository.ts and mocks only its one
 * dependency, `@/lib/supabase/server`, with a call-recording fake query
 * builder.
 *
 * `repository.ts` captures `supabaseAdmin` into a module-scope `const db` at
 * first import. Bun's `mock.module()` replaces a module's cache entry for
 * the rest of the whole `bun test` process — not just the file that called
 * it — and nothing restores it automatically between test files. Depending
 * on Bun's (non-alphabetical, content-sensitive) file scheduling, this file
 * can run after something that already imported or mocked
 * `@/server/team/repository` (e.g. team-domain.test.ts's
 * `installRepoMock()`), so a plain `await import("../server/team/repository")`
 * here could silently return that stale cached module — never touching the
 * builder below — instead of a fresh, builder-bound one, leaving `calls`
 * empty and failing the assertions below. The `?isolate=` query suffix
 * forces Bun to treat the import as a brand-new module specifier every run,
 * guaranteeing a fresh evaluation of the real repository.ts bound to THIS
 * test's builder regardless of what already ran in the process.
 *
 * This file still runs its repository.ts exercises inside ONE `it()`,
 * against ONE shared fake `supabaseAdmin`, for simplicity — not because a
 * second `it()` would be unsafe anymore. `makeFakeSupabaseAdmin()`'s
 * `resolve` callback is given the table name and every `.eq()` filter
 * applied since the last `.from()`, so one builder can stand in for several
 * distinct tables/queries — including two different lookups against the
 * SAME table with different filters — within a single pass.
 *
 * Run: bun test src/tests/team-repository.test.ts
 */
import { describe, it, expect, mock } from "bun:test";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";

type Filters = Record<string, unknown>;

function makeFakeSupabaseAdmin(resolve: (table: string, filters: Filters) => unknown) {
  const calls: { method: string; args: unknown[] }[] = [];
  let currentTable = "";
  let currentFilters: Filters = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {
    from: (...args: unknown[]) => {
      calls.push({ method: "from", args });
      currentTable = args[0] as string;
      currentFilters = {};
      return builder;
    },
    select: (...args: unknown[]) => {
      calls.push({ method: "select", args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      calls.push({ method: "eq", args });
      currentFilters[args[0] as string] = args[1];
      return builder;
    },
    ilike: (...args: unknown[]) => {
      calls.push({ method: "ilike", args });
      currentFilters[args[0] as string] = args[1];
      return builder;
    },
    order: (...args: unknown[]) => {
      calls.push({ method: "order", args });
      return builder;
    },
    limit: (...args: unknown[]) => {
      calls.push({ method: "limit", args });
      return builder;
    },
    maybeSingle: async () => {
      calls.push({ method: "maybeSingle", args: [] });
      return { data: resolve(currentTable, currentFilters), error: null };
    },
  };
  return { builder, calls };
}

describe("Repository query safety", () => {
  const membershipJoinRow = {
    id: "m-suspended-owner",
    user_id: "user-owner-1",
    organization_id: ORG_A,
    role_id: "00000000-0000-0000-0000-000000000001",
    status: "suspended",
    joined_at: "2026-01-01T00:00:00.000Z",
    invited_by: null,
    profiles: { display_name: "Former Owner", email: "owner@example.com", phone: null },
    roles: { name: "Owner", system_role: "OWNER" },
  };

  // Everything below shares ONE builder/import — see file header comment.
  it("exercises findPendingInvitationByEmail and findMembershipByEmail against the real repository", async () => {
    const { builder, calls } = makeFakeSupabaseAdmin((table, filters) => {
      if (table === "invitations") return null;
      if (table === "profiles") {
        return filters.email === "owner@example.com" ? { id: "user-owner-1" } : null;
      }
      if (table === "memberships") {
        return filters.user_id === "user-owner-1" && filters.organization_id === ORG_A
          ? membershipJoinRow
          : null;
      }
      return null;
    });
    mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: builder }));

    // See file header: cache-bust so this always re-evaluates the real
    // repository.ts against the builder above, never a stale cached module.
    const isolate = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const repository = await import(`../server/team/repository?isolate=${isolate}`);

    // ── findPendingInvitationByEmail: exact match, never .ilike() ──────────
    await repository.findPendingInvitationByEmail(ORG_A, "  Someone@Example.COM  ");
    await repository.findPendingInvitationByEmail(ORG_A, "%@corp.kh");

    expect(calls.some((c) => c.method === "ilike")).toBe(false);
    expect(
      calls.some(
        (c) => c.method === "eq" && c.args[0] === "email" && c.args[1] === "someone@example.com",
      ),
    ).toBe(true);
    // .eq() sends the literal string to Postgres; only .ilike()/.like() would
    // interpret % as a wildcard. Combined with .ilike() never being called
    // above, an invite address containing SQL wildcard characters can never
    // match (and 409-collide with) an unrelated pending invite in the org.
    expect(
      calls.some((c) => c.method === "eq" && c.args[0] === "email" && c.args[1] === "%@corp.kh"),
    ).toBe(true);

    // ── findMembershipByEmail: resolves email → profile → membership, ──────
    // ── across EVERY status (CORRECTION-001 invite-time authority check) ───
    const callsBeforeMembershipLookup = calls.length;
    const found = await repository.findMembershipByEmail(ORG_A, "  Owner@Example.COM  ");
    const membershipLookupCalls = calls.slice(callsBeforeMembershipLookup);
    expect(found).not.toBeNull();
    expect(found?.id).toBe("m-suspended-owner");
    expect(found?.status).toBe("suspended");
    expect(found?.role.system_role).toBe("OWNER");
    // No status filter — a suspended/removed row must stay visible to this
    // lookup, or a Manager could dodge the authority check just by the
    // target already being suspended when the invite is sent. (Scoped to
    // just this call's own calls — findPendingInvitationByEmail above
    // legitimately filters by status='pending' for its own table.)
    expect(membershipLookupCalls.some((c) => c.method === "eq" && c.args[0] === "status")).toBe(
      false,
    );

    const notFound = await repository.findMembershipByEmail(ORG_A, "nobody@example.com");
    expect(notFound).toBeNull();
  });
});
