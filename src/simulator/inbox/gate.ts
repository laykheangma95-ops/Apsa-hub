/**
 * The single gate for the Inbox simulator (internal testing tool, never a
 * merchant feature).
 *
 * Fail-closed: the simulator is available ONLY when the build is positively a
 * Vite development build (`DEV` is explicitly true) AND is not a production
 * build. Missing, malformed or unexpected values all mean "unavailable".
 * There is no opt-in env variable, so forgetting to configure anything can
 * never expose it. No imports, no secrets.
 */

export const SIMULATOR_UNAVAILABLE = "simulator_unavailable";

const isTrue = (value: unknown): boolean => value === true || value === "true";

export function inboxSimulatorEnabled(
  env: Record<string, unknown> | undefined = import.meta.env,
): boolean {
  if (!env || typeof env !== "object") return false;
  if (isTrue(env["PROD"])) return false;
  return isTrue(env["DEV"]);
}
