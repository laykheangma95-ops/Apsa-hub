/**
 * Navigation timing telemetry — TanStack Start API boundary.
 * Staging/development diagnostics ONLY; measurement, never a decision.
 *
 * The browser (src/lib/perf/navigation-timing.ts, only when the build sets
 * VITE_APSA_PERF_NAV_TIMING=true) posts one allowlisted record per completed
 * navigation. The server logs it only when APSA_PERF_INSTRUMENTATION=true and
 * never on VERCEL_ENV=production (src/server/observability/navigation-telemetry.ts).
 *
 * - No session read, no organization resolution, no database access: the
 *   record is not tied to any identity, so there is nothing to authorize.
 * - The validator only passes the body through; the allowlist schema is
 *   applied inside the handler so a rejected payload is dropped silently
 *   instead of becoming an error log line.
 * - Returns nothing, so the payload is never echoed.
 * - CSRF-protected like every server function (src/start.ts).
 */
import { createServerFn } from "@tanstack/react-start";

export const recordNavigationTimingFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async ({ data }): Promise<void> => {
    const { ingestNavigationTelemetry } =
      await import("@/server/observability/navigation-telemetry");
    ingestNavigationTelemetry(data);
  });
