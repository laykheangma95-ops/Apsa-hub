import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    // Structured, redacted, with the same reporter as server functions.
    const { reportServerError } = await import("./server/observability/errors");
    reportServerError(error, { event: "ssr.unhandled_error" });
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Start installs this automatically when src/start.ts is absent; defining the
// file opts out, so re-add it explicitly to keep server functions protected
// from cross-site requests.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

// Every server function runs inside the observability boundary: request ID,
// structured redacted error logging, and a sanitized public error (with a
// support reference) instead of raw database text for unexpected failures.
// See src/server/observability/server-fn-boundary.ts. Dynamically imported so
// no server-only module enters the client bundle.
const serverFnBoundary = createMiddleware({ type: "function" }).server(
  async ({ next, serverFnMeta }) => {
    const { runServerFnBoundary } = await import("./server/observability/server-fn-boundary");
    return runServerFnBoundary(serverFnMeta, () => next());
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware, csrfMiddleware],
  functionMiddleware: [serverFnBoundary],
}));
