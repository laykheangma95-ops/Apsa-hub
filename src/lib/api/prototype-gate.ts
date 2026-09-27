/**
 * The production gate for the in-memory prototype fixtures in src/lib/mock.
 *
 * `src/lib/api/index.ts` still carries a handful of prototype-only paths: the
 * non-UUID ("cus-1", "ord-1", "conv-1") detail screens, the prototype
 * createOrder/createSale, and the demo-mode fallbacks that let `bun test`
 * render screens without a TanStack Start runtime. Each is guarded by an id
 * shape or an error-message match — conventions that hold for data APSA
 * itself produces, but NOT for a URL somebody types. `/app/orders/ord-1` was a
 * fully rendered, fabricated order (with a fabricated customer, payments and a
 * "record payment" that reported success) on a production deployment.
 *
 * This gate closes that structurally: in a production build every prototype
 * path refuses, so a non-UUID id is simply "not found" and a server failure is
 * always a failure, never fixture data.
 *
 * `import.meta.env.PROD` is statically replaced by Vite with `true` in a
 * production build (client and SSR bundles alike), so the fixtures can never
 * be served there. Under `bun test`, `import.meta.env` is `process.env`, where
 * PROD is unset — the existing prototype-backed test suites keep working, and
 * a test can set `process.env.PROD = "true"` to exercise the production gate.
 *
 * Safe to bundle for the browser: no imports, no secrets.
 */

/** The error every gated prototype path throws in production. */
export const PROTOTYPE_UNAVAILABLE = "prototype_unavailable";

/** True when fixture-backed prototype paths may run (tests, dev); false in production builds. */
export function prototypeFixturesAllowed(): boolean {
  const prod: unknown = import.meta.env.PROD;
  return !(prod === true || prod === "true");
}

/**
 * Throws in a production build. Call at the top of every prototype-only path
 * before it reads anything from src/lib/mock.
 */
export function assertPrototypeFixturesAllowed(): void {
  if (!prototypeFixturesAllowed()) throw new Error(PROTOTYPE_UNAVAILABLE);
}

/**
 * Returns true ONLY for errors that are structurally impossible in production:
 *   - TanStack Start runtime not found: server function called outside the HTTP
 *     runtime (e.g. bun test, Storybook). This never occurs in production
 *     because the server function middleware is always active there.
 *
 * UnauthorizedError (no session) is NOT a demo-mode fallback: a real auth or
 * backend outage can produce it in production, so it must propagate as an error
 * rather than be silently hidden behind mock data.
 *
 * All other errors — DB failures, ForbiddenError, UnauthorizedError, 5xx — must
 * propagate so production failures are visible rather than silently hidden
 * behind mock data.
 */
export function isDemoModeError(err: unknown): boolean {
  // Production builds never fall back to fixtures, whatever the error says.
  if (!prototypeFixturesAllowed()) return false;
  if (!(err instanceof Error)) return false;
  // TanStack Start server function called outside its runtime (test / Storybook).
  // This is structurally impossible in production where the middleware is always active.
  if (err.message.includes("No Start context") || err.message.includes("AsyncLocalStorage")) {
    return true;
  }
  return false;
}
