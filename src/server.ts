import "./lib/error-capture";

import { consumeCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { healthResponse, isHealthRequest } from "./lib/health";
import { missingServerEnv } from "./server/observability/env-check";
import { reportServerError } from "./server/observability/errors";
import { serverLog } from "./server/observability/logger";
import { runWithRequestContext } from "./server/observability/request-context";
import { newRequestId } from "./server/observability/request-id";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  // The captured error is THIS request's (request-context.ts#capture). The
  // fallback describes the swallow without quoting the response body.
  reportServerError(consumeCapturedError() ?? new Error("h3 swallowed SSR error"), {
    event: "ssr.swallowed_error",
  });
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

// Once per server instance: name (never value) any required variable that is
// missing, so a misconfigured deployment is visible in the logs on its first
// request instead of as scattered failures.
let environmentChecked = false;
function logMissingEnvironmentOnce(): void {
  if (environmentChecked) return;
  environmentChecked = true;
  const missing = missingServerEnv(process.env, process.env["NODE_ENV"] === "production");
  if (missing.length > 0) serverLog.error("server.env_missing", { missing });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    logMissingEnvironmentOnce();
    // Liveness only — answered before the app router, touches nothing.
    if (isHealthRequest(request)) return healthResponse(request.method);
    // One request context per HTTP request: its request ID correlates every
    // log line, and its capture slot holds only this request's swallowed error.
    return runWithRequestContext({ requestId: newRequestId(), capture: {} }, async () => {
      try {
        const handler = await getServerEntry();
        const response = await handler.fetch(request, env, ctx);
        return await normalizeCatastrophicSsrResponse(response);
      } catch (error) {
        reportServerError(error, { event: "ssr.unhandled_error" });
        return new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
    });
  },
};
