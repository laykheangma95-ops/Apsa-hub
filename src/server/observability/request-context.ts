/**
 * Per-request correlation context for server code.
 *
 * The server-function boundary (src/server/observability/server-fn-boundary.ts)
 * opens one context per server-function call; anything that logs inside that
 * call — a service, a repository, the rate limiter — picks the request ID up
 * from here without it being threaded through every signature.
 *
 * AsyncLocalStorage is the same primitive TanStack Start already relies on for
 * its own request context, so it adds no new runtime requirement. The store is
 * per async call chain, never shared between concurrent requests, and never
 * global mutable state.
 *
 * Server-only. Never import this from browser-bundled code.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PerfCollector } from "./perf";

export interface RequestContext {
  requestId: string;
  /** Server function name ("createOrderFn"), when known. */
  operation?: string;
  /** Domain derived from the server-function file ("orders"), when known. */
  domain?: string;
  /**
   * True once the server-function boundary owns this call chain. A nested
   * server-function call sees it set and leaves logging/sanitization to the
   * outer boundary. An HTTP-level context (src/server.ts) does NOT set it.
   */
  serverFnBoundary?: boolean;
  /**
   * The request's own error-capture slot (src/lib/error-capture.ts). Created
   * per HTTP request; a mutable box inside the per-request store, so one
   * request can never read or consume another request's captured error.
   */
  capture?: { error?: unknown };
  /**
   * Phase timings for this server-function call. Present only when
   * APSA_PERF_INSTRUMENTATION is enabled (src/server/observability/perf.ts);
   * diagnostics only, never read by any authorization decision.
   */
  perf?: PerfCollector;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Remember an error for the CURRENT request only. Outside a request context
 * (module init, a timer with no request) it is dropped — there is no global
 * fallback slot.
 */
export function recordRequestError(error: unknown): void {
  const capture = storage.getStore()?.capture;
  if (capture) capture.error = error;
}

/** Take (and clear) the error captured for the CURRENT request, if any. */
export function consumeRequestError(): unknown {
  const capture = storage.getStore()?.capture;
  if (!capture) return undefined;
  const { error } = capture;
  capture.error = undefined;
  return error;
}
