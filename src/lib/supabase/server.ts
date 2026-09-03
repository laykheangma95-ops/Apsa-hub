/**
 * Server-side Supabase client — SERVICE ROLE.
 *
 * NEVER import this file in any file that is bundled for the browser.
 * NEVER expose process.env.SUPABASE_SERVICE_ROLE_KEY to the client.
 * NEVER use VITE_ prefix for SUPABASE_SERVICE_ROLE_KEY.
 *
 * This client bypasses RLS and must only be used from trusted server code
 * after application-layer authorization has already been verified.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

const supabaseUrl = process.env['VITE_SUPABASE_URL'];
const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY on the server. " +
      "Configure server environment — never expose service role key to the browser.",
  );
}

export const supabaseAdmin = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
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
