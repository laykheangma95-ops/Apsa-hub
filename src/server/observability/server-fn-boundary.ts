/**
 * The server-function boundary — installed once, globally, as TanStack Start
 * function middleware in src/start.ts, so every createServerFn handler runs
 * inside it. No handler has to opt in.
 *
 * Per call it:
 *   1. opens a request context with a fresh random request ID
 *      (src/server/observability/request-id.ts), the server function's name
 *      as `operation` and its API file as `domain`;
 *   2. lets domain errors (numeric statusCode, service-authored message) and
 *      TanStack control flow (redirect / notFound / Response) through
 *      unchanged — the UI's error classifiers depend on those messages;
 *   3. for anything else — the unexpected failures — writes ONE structured,
 *      redacted log line (and forwards it to the registered ErrorReporter, if
 *      any), then throws a PUBLIC error instead: a fixed message plus
 *      `[ref:<requestId>]`. The original message, stack, SQL text, table or
 *      constraint names never reach the browser.
 *
 * Nested server-function calls made on the server (e.g. getSessionFn() from
 * inside another handler) reuse the outer context and leave error handling to
 * the outermost boundary, so one failure is logged once under one ID.
 *
 * Server-only. Dynamically imported by src/start.ts inside the middleware's
 * server callback.
 */
import { newRequestId } from "./request-id";
import { currentRequestContext, runWithRequestContext } from "./request-context";
import {
  describeErrorForLog,
  isControlFlowThrow,
  isPublicDomainError,
  reportServerError,
  toPublicInternalError,
} from "./errors";
import { serverLog } from "./logger";

export interface ServerFnMetaLike {
  name?: string;
  filename?: string;
}

/** "src/api/orders.ts" → "orders". Anything unrecognised → undefined. */
export function domainFromFilename(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const match = /(?:^|\/)api\/([A-Za-z0-9_-]+)\.[cm]?[jt]sx?$/.exec(filename);
  return match?.[1];
}

export async function runServerFnBoundary<T>(
  meta: ServerFnMetaLike | undefined,
  next: () => Promise<T>,
): Promise<T> {
  // Nested call on the server: the outermost boundary owns logging and
  // sanitization for this request.
  if (currentRequestContext()) return next();

  const requestId = newRequestId();
  const domain = domainFromFilename(meta?.filename);
  const context = {
    requestId,
    ...(meta?.name ? { operation: meta.name } : {}),
    ...(domain ? { domain } : {}),
  };

  return runWithRequestContext(context, async () => {
    const startedAt = Date.now();
    try {
      return await next();
    } catch (error) {
      if (isControlFlowThrow(error)) throw error;

      const durationMs = Date.now() - startedAt;

      if (isPublicDomainError(error)) {
        const { errorClass, errorCode, statusCode, retryable } = describeErrorForLog(error);
        const fields = {
          errorClass,
          ...(errorCode ? { errorCode } : {}),
          ...(statusCode !== undefined ? { statusCode } : {}),
          retryable,
          durationMs,
        };
        // Expected outcomes are logged without their message: a 4xx is the
        // caller's problem, and its text can echo their input.
        if (statusCode !== undefined && statusCode >= 500) {
          reportServerError(error, { event: "server_fn.failed", durationMs });
        } else if (statusCode === 403 || statusCode === 429) {
          serverLog.warn("server_fn.rejected", fields);
        } else {
          serverLog.info("server_fn.rejected", fields);
        }
        throw error;
      }

      reportServerError(error, { event: "server_fn.unexpected_error", durationMs });
      throw toPublicInternalError(requestId);
    }
  });
}
