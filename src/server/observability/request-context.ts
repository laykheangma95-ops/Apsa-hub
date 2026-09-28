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

export interface RequestContext {
  requestId: string;
  /** Server function name ("createOrderFn"), when known. */
  operation?: string;
  /** Domain derived from the server-function file ("orders"), when known. */
  domain?: string;
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
