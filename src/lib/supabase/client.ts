/**
 * Browser-side Supabase client.
 *
 * Uses the anon/public key only — safe for browser code.
 * Do NOT import SUPABASE_SERVICE_ROLE_KEY or any server-only env here.
 * This client is subject to Supabase RLS policies.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

const supabaseUrl = import.meta.env['VITE_SUPABASE_URL'];
const supabaseAnonKey = import.meta.env['VITE_SUPABASE_ANON_KEY'];

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
      "Copy .env.example to .env.local and fill in your APSA Supabase credentials.",
  );
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
