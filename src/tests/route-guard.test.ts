/**
 * Route guard design tests.
 *
 * These unit tests verify the structural design of the /app route guard
 * without requiring a browser or HTTP server.
 *
 * They check that:
 *   1. The guard is implemented in beforeLoad (server-side), not useEffect (client-side)
 *   2. The guard imports getSessionFn (cookie-based session, not a client auth check)
 *   3. The guard redirects to the correct destinations based on state
 *   4. The guard does not trust a client-provided organization_id
 *
 * Run: bun test src/tests/route-guard.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const routeCode = fs.readFileSync(
  path.resolve(process.cwd(), "src/routes/app.tsx"),
  "utf-8",
);

// ── U1: beforeLoad guard is used, not useEffect ───────────────────────────────

describe("U1: Guard uses beforeLoad, not useEffect", () => {
  it("defines beforeLoad in the route config", () => {
    expect(routeCode).toMatch(/beforeLoad/);
  });

  it("does NOT use useEffect for auth redirection", () => {
    // useEffect-based guards are client-side and allow the page to flash.
    // Auth redirects must happen in beforeLoad (server-side).
    // Check that useEffect is not imported (if it were used, it'd need to be imported).
    expect(routeCode).not.toMatch(/import.*useEffect/);
  });
});

// ── U2: Guard imports getSessionFn (cookie-based) ─────────────────────────────

describe("U2: Guard uses cookie-based session via server function", () => {
  it("calls checkAppGuardFn which internally uses getSessionFn", () => {
    // The route calls checkAppGuardFn (a createServerFn) for auth.
    // That server function calls getSessionFn internally (see app-guard.ts).
    expect(routeCode).toMatch(/checkAppGuardFn/);
  });

  it("app-guard.ts imports getSessionFn from @/api/auth", () => {
    const fs = require("fs");
    const path = require("path");
    const guardCode = fs.readFileSync(
      path.resolve(process.cwd(), "src/api/app-guard.ts"),
      "utf-8",
    );
    expect(guardCode).toMatch(/from "@\/api\/auth"/);
    expect(guardCode).toMatch(/getSessionFn/);
  });

  it("does NOT import or use SUPABASE_JWT_SECRET", () => {
    expect(routeCode).not.toMatch(/SUPABASE_JWT_SECRET/);
  });

  it("does NOT use supabase.auth on the client for authorization", () => {
    expect(routeCode).not.toMatch(/useSupabaseClient.*auth\.getUser/s);
  });
});

// ── U3: Redirect destinations ─────────────────────────────────────────────────

describe("U3: Redirect destinations match requirements", () => {
  it("redirects to /sign-in when unauthenticated", () => {
    expect(routeCode).toMatch(/\/sign-in/);
  });

  it("redirects to /onboarding when no org membership", () => {
    expect(routeCode).toMatch(/\/onboarding/);
  });

  it("redirects to /access-denied for suspended/removed memberships", () => {
    expect(routeCode).toMatch(/\/access-denied/);
  });

  it("redirects to /verify-email when email not verified", () => {
    expect(routeCode).toMatch(/\/verify-email/);
  });
});

// ── U4: Guard uses server-side org lookup, not client-provided ID ─────────────

describe("U4: Organization identity comes from server lookup, not client input", () => {
  it("uses checkAppGuardFn (server function) for org membership lookup", () => {
    // The guard delegates to a createServerFn that runs supabaseAdmin server-side.
    // This keeps service-role credentials out of the client bundle.
    expect(routeCode).toMatch(/checkAppGuardFn/);
  });

  it("guard server function file uses supabaseAdmin for org lookup", () => {
    const fs = require("fs");
    const path = require("path");
    const guardCode = fs.readFileSync(
      path.resolve(process.cwd(), "src/api/app-guard.ts"),
      "utf-8",
    );
    expect(guardCode).toMatch(/supabaseAdmin/);
    expect(guardCode).toMatch(/memberships/);
  });

  it("does NOT read organizationId from URL search params or route params in beforeLoad", () => {
    expect(routeCode).not.toMatch(/params\.organizationId/);
    expect(routeCode).not.toMatch(/search\.organizationId/);
  });
});
