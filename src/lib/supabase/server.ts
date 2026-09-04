/**
 * Server-side Supabase utilities.
 *
 * NEVER import this file in any file that is bundled for the browser.
 * NEVER expose SUPABASE_SERVICE_ROLE_KEY to the client.
 * NEVER use VITE_ prefix for SUPABASE_SERVICE_ROLE_KEY.
 *
 * supabaseAdmin: service-role client that bypasses RLS. Use only after
 * application-layer authorization has already been verified.
 *
 * createServerClient: user-scoped client that respects RLS (defense-in-depth).
 *
 * createRefreshClient: anon-key client used exclusively for token refresh.
 *
 * TESTABILITY: supabaseAdmin is lazily initialized — importing this module
 * never throws, even when credentials are absent, allowing unit tests that
 * never touch the DB to load auth modules without Supabase env vars.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

// ── Cookie names (shared with src/api/auth.ts) ────────────────────────────────
export const COOKIE_ACCESS_TOKEN = "sb-access-token";
export const COOKIE_REFRESH_TOKEN = "sb-refresh-token";

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env["NODE_ENV"] === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 7, // 7 days (refresh token lifetime)
} as const;

type AdminClient = ReturnType<typeof createClient<Database>>;

function buildAdminClient(): AdminClient {
  const supabaseUrl = process.env['VITE_SUPABASE_URL'];
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY on the server. " +
        "Configure server environment — never expose service role key to the browser.",
    );
  }

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Lazy singleton — the real client is constructed on the first property access,
// not at module load time. This preserves the supabaseAdmin.from(...) call
// pattern at all call sites with no changes required there.
let _adminClient: AdminClient | null = null;

export const supabaseAdmin: AdminClient = new Proxy({} as AdminClient, {
  get(_target: AdminClient, prop: string | symbol): unknown {
    if (!_adminClient) _adminClient = buildAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_adminClient as any)[prop];
  },
});

/**
 * Create a user-scoped Supabase client authenticated via the caller's JWT.
 * This client respects RLS and is appropriate for calling RPCs that use auth.uid().
 * Never use this for privileged admin operations — use supabaseAdmin for those.
 */
export function createServerClient(accessToken: string) {
  const url = process.env['VITE_SUPABASE_URL']!;
  const anonKey = process.env['VITE_SUPABASE_ANON_KEY']!;

  return createClient<Database>(url, anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Create an anonymous-key client used exclusively for token refresh.
 * Does NOT carry a user JWT — call refreshSession({ refresh_token }) on it.
 */
export function createRefreshClient() {
  const url = process.env['VITE_SUPABASE_URL']!;
  const anonKey = process.env['VITE_SUPABASE_ANON_KEY']!;

  return createClient<Database>(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
