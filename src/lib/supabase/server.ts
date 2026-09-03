/**
 * Server-side Supabase client — SERVICE ROLE.
 *
 * NEVER import this file in any file that is bundled for the browser.
 * NEVER expose process.env.SUPABASE_SERVICE_ROLE_KEY to the client.
 * NEVER use VITE_ prefix for SUPABASE_SERVICE_ROLE_KEY.
 *
 * This client bypasses RLS and must only be used from trusted server code
 * after application-layer authorization has already been verified.
 *
 * TESTABILITY: supabaseAdmin is lazily initialized. The Supabase client is
 * not constructed until the first property access. Importing this module does
 * not throw even when credentials are absent, which allows unit tests that
 * never touch the DB to load auth modules without Supabase env vars.
 * Production code still fails immediately and clearly when credentials are
 * absent — at the point the client is first used, not at import time.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

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
 * Create a Supabase client that impersonates the authenticated user via JWT.
 * This client still respects RLS — used when we want RLS as a defense-in-depth
 * layer on top of application-layer checks, without full service-role bypass.
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
