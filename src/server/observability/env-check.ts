/**
 * Required server environment — NAMES only.
 *
 * Shared by the server entry (logs, once per instance, which required names
 * are missing) and scripts/verify-readiness.ts. Values are never read out,
 * logged or returned; presence is all that is checked.
 */

/** Without these the server cannot authenticate anyone or reach its database. */
export const REQUIRED_SERVER_ENV = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

/**
 * Required when NODE_ENV=production: auth emails must link to the canonical
 * origin, never one derived from a request Host header (src/api/auth.ts).
 */
export const REQUIRED_PRODUCTION_ENV = ["VITE_APP_URL"] as const;

/** Optional hardening; absence is reported, never fatal. */
export const OPTIONAL_SERVER_ENV = [
  // Dedicated HMAC pepper for rate-limit keys (else derived from the service key).
  "RATE_LIMIT_KEY_SECRET",
  // The one forwarding header the deployment's proxy guarantees for client IPs.
  "RATE_LIMIT_CLIENT_IP_HEADER",
] as const;

export function missingServerEnv(
  env: Record<string, string | undefined>,
  production: boolean,
): string[] {
  const required: readonly string[] = production
    ? [...REQUIRED_SERVER_ENV, ...REQUIRED_PRODUCTION_ENV]
    : REQUIRED_SERVER_ENV;
  return required.filter((name) => !env[name] || env[name]!.trim() === "");
}
