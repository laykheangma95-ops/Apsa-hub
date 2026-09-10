/**
 * Team repository query-safety tests — src/server/team/repository.ts.
 *
 * Deliberately a SEPARATE file from team-domain.test.ts: every test there
 * mocks the whole repository module (`mock.module("@/server/team/repository", ...)`)
 * so service.ts never touches the real repository.ts. This file does the
 * opposite — it imports the REAL repository.ts and mocks only its one
 * dependency, `@/lib/supabase/server`, with a call-recording fake query
 * builder. `repository.ts` captures `supabaseAdmin` into a module-scope
 * `const db` at first import, so it must be the first (and only) thing in
 * the whole `bun test` process to import `@/server/team/repository` —
 * sharing a file with anything that mocks the repository module itself
 * would let a stale, already-real-bound copy leak in via module caching.
 *
 * Run: bun test src/tests/team-repository.test.ts
 */
import { describe, it, expect, mock } from "bun:test";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";

function makeFakeSupabaseAdmin(resultRow: unknown) {
  const calls: { method: string; args: unknown[] }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {
    from: (...args: unknown[]) => {
      calls.push({ method: "from", args });
      return builder;
    },
    select: (...args: unknown[]) => {
      calls.push({ method: "select", args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      calls.push({ method: "eq", args });
      return builder;
    },
    ilike: (...args: unknown[]) => {
      calls.push({ method: "ilike", args });
      return builder;
    },
    maybeSingle: async () => {
      calls.push({ method: "maybeSingle", args: [] });
      return { data: resultRow, error: null };
    },
  };
  return { builder, calls };
}

describe("Repository query safety — exact email match, no ilike wildcard", () => {
  // A single test, deliberately: repository.ts captures `supabaseAdmin` into
  // a module-scope `const db` the first time it is imported in this process,
  // so only the FIRST `@/lib/supabase/server` mock in effect at that moment
  // ever takes hold — a second `mock.module()` + re-import in a later test
  // would silently keep calling into the first test's builder. Exercising
  // both inputs against one shared builder/calls array sidesteps that.
  it("looks up a pending invite by exact, normalized email — never .ilike(), and a wildcard-shaped input is passed through as a literal", async () => {
    const { builder, calls } = makeFakeSupabaseAdmin(null);
    mock.module("@/lib/supabase/server", () => ({ supabaseAdmin: builder }));

    const repository = await import("../server/team/repository");
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
  });
});
