/**
 * Public liveness endpoint: GET/HEAD /api/health.
 *
 * Answers exactly one question — "is this deployment's server process up and
 * routing requests?" — with `{"status":"ok"}`. It deliberately reveals
 * nothing else: no version, commit, region, environment variable, database
 * state or migration level. It does NOT touch the database, so it cannot be
 * used to generate database load or to probe infrastructure.
 *
 * "Ready to serve real merchants" is a different, privileged question
 * answered by scripts/verify-readiness.ts with service-role credentials, never
 * by a public URL.
 *
 * Dispatched from src/server.ts before the application router.
 */

export const HEALTH_PATH = "/api/health";

export function isHealthRequest(request: Request): boolean {
  try {
    return new URL(request.url).pathname === HEALTH_PATH;
  } catch {
    return false;
  }
}

export function healthResponse(method: string): Response {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
  };
  if (method !== "GET" && method !== "HEAD") {
    return new Response(JSON.stringify({ status: "method_not_allowed" }), {
      status: 405,
      headers: { ...headers, allow: "GET, HEAD" },
    });
  }
  return new Response(method === "HEAD" ? null : JSON.stringify({ status: "ok" }), {
    status: 200,
    headers,
  });
}
