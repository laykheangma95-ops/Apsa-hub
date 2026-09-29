/**
 * The single gate for the Inbox simulator (internal testing tool, never a
 * merchant feature).
 *
 * Fail-closed: the simulator is available ONLY when the build is positively a
 * Vite development build (`DEV` is exactly boolean true) AND is not a production
 * build (`PROD` is exactly boolean false). Missing, malformed or unexpected
 * values all mean "unavailable".
 * There is no opt-in env variable, so forgetting to configure anything can
 * never expose it. No imports, no secrets.
 */

export const SIMULATOR_UNAVAILABLE = "simulator_unavailable";

export function inboxSimulatorEnabled(
  env: Record<string, unknown> | undefined = import.meta.env,
): boolean {
  if (!env || typeof env !== "object") return false;
  return env["DEV"] === true && env["PROD"] === false;
}
