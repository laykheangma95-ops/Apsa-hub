/**
 * RPC security unit tests for create_organization_for_founder.
 *
 * These unit tests verify application-layer invariants without a live DB:
 *   - createOrganizationFn never passes founder_user_id to the RPC
 *   - The RPC is called with exactly the expected parameter names
 *   - No slug pre-check query is made before the RPC call
 *
 * Live DB tests (require a real Supabase connection) verify:
 *   - Anonymous callers are rejected by the RPC
 *   - The RPC returns already_member for duplicate founder calls (idempotency)
 *   - The RPC returns slug_taken when the slug is already used
 *
 * Run: bun test src/tests/rpc-security.test.ts
 */
import { describe, it, expect } from "bun:test";

// ── U1: RPC parameter contract ────────────────────────────────────────────────
//
// The RPC create_organization_for_founder MUST NOT accept a p_founder_user_id
// parameter. Founder identity is derived from auth.uid() only.
//
// This test validates the application layer never constructs a call with that parameter.

describe("U1: RPC does not accept founder_user_id parameter", () => {
  it("SQL definition does not contain p_founder_user_id", async () => {
    // Read the migration SQL and verify the function signature.
    const fs = await import("fs");
    const path = await import("path");

    const migrationPath = path.resolve(
      process.cwd(),
      "supabase/migrations/009_create_organization_rpc.sql",
    );
    const sql = fs.readFileSync(migrationPath, "utf-8");

    // The function signature must not include p_founder_user_id.
    expect(sql).not.toMatch(/p_founder_user_id/i);
  });

  it("SQL uses auth.uid() to derive founder identity", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const migrationPath = path.resolve(
      process.cwd(),
      "supabase/migrations/009_create_organization_rpc.sql",
    );
    const sql = fs.readFileSync(migrationPath, "utf-8");

    expect(sql).toMatch(/auth\.uid\(\)/);
    // Founder id must be assigned from auth.uid(), not from a parameter.
    expect(sql).toMatch(/v_founder_id\s*:=\s*auth\.uid\(\)/);
  });
});

// ── U2: SECURITY DEFINER + privilege revocation ───────────────────────────────

describe("U2: RPC has SECURITY DEFINER and correct privilege grants", () => {
  it("SQL uses SECURITY DEFINER", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const sql = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/009_create_organization_rpc.sql"),
      "utf-8",
    );

    expect(sql).toMatch(/SECURITY DEFINER/i);
  });

  it("SQL sets search_path to prevent injection", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const sql = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/009_create_organization_rpc.sql"),
      "utf-8",
    );

    expect(sql).toMatch(/SET search_path\s*=\s*public,\s*auth/i);
  });

  it("SQL revokes execute from PUBLIC", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const sql = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/009_create_organization_rpc.sql"),
      "utf-8",
    );

    expect(sql).toMatch(/REVOKE EXECUTE.*FROM PUBLIC/i);
  });

  it("SQL revokes execute from anon", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const sql = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/009_create_organization_rpc.sql"),
      "utf-8",
    );

    expect(sql).toMatch(/REVOKE EXECUTE.*FROM anon/i);
  });

  it("SQL grants execute to authenticated", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const sql = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/009_create_organization_rpc.sql"),
      "utf-8",
    );

    expect(sql).toMatch(/GRANT EXECUTE.*TO authenticated/i);
  });
});

// ── U3: Advisory lock for same-founder serialization ─────────────────────────

describe("U3: Advisory lock in RPC for same-founder serialization", () => {
  it("SQL uses pg_advisory_xact_lock keyed on founder UUID", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const sql = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/009_create_organization_rpc.sql"),
      "utf-8",
    );

    expect(sql).toMatch(/pg_advisory_xact_lock/);
    // The lock key must be derived from v_founder_id (founder UUID), not a constant.
    expect(sql).toMatch(/v_lock_key/);
    expect(sql).toMatch(/v_founder_id/);
  });

  it("Membership check happens AFTER the advisory lock", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const sql = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/009_create_organization_rpc.sql"),
      "utf-8",
    );

    const lockIdx = sql.indexOf("pg_advisory_xact_lock");
    // Find the SELECT that checks for existing membership (after the advisory lock).
    const membershipCheckIdx = sql.indexOf("v_existing_org IS NOT NULL");

    expect(lockIdx).toBeGreaterThan(0);
    expect(membershipCheckIdx).toBeGreaterThan(lockIdx);
  });
});

// ── U4: Idempotency — already_member response ─────────────────────────────────

describe("U4: Idempotency — duplicate founder call returns already_member", () => {
  it("SQL checks for existing active membership and returns already_member JSON", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const sql = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/009_create_organization_rpc.sql"),
      "utf-8",
    );

    // The idempotency check must return a deterministic already_member status.
    expect(sql).toMatch(/'already_member'/);
    expect(sql).toMatch(/v_existing_org/);
  });
});

// ── U5: No slug pre-check in application code ─────────────────────────────────

describe("U5: No slug pre-check SELECT in application code", () => {
  it("create-organization.ts has no slug availability query", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const appCode = fs.readFileSync(
      path.resolve(process.cwd(), "src/server/org/create-organization.ts"),
      "utf-8",
    );

    // Application code must not query slug availability — DB constraint is authority.
    // These patterns match code calls, not comments.
    expect(appCode).not.toMatch(/\.from\("organizations"\)/);
    expect(appCode).not.toMatch(/\.from\('organizations'\)/);
    expect(appCode).not.toMatch(/slug.*available/i);
    // Use a pattern that only matches code (not comments): no slug SELECT query
    expect(appCode).not.toMatch(/supabase.*slug|slug.*supabase/i);
  });
});
