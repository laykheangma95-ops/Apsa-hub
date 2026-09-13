/**
 * Build-time feature flags with a runtime rollback lever.
 *
 * A flag here is a deployment switch, never an authorization boundary: it
 * decides which shell a merchant sees, and nothing about what the server will
 * let them do. Every screen behind a flagged surface is still guarded on its
 * own route and authorized again server-side.
 *
 * Two inputs, in order:
 *   1. `VITE_<FLAG>` in the environment — the deploy-time default. Set it to
 *      "0" / "off" / "false" to roll the flag back without shipping code.
 *   2. `localStorage["apsa.flag.<FLAG>"]` — a per-browser override so support
 *      can reproduce either shell on a real device against a live build.
 *
 * Safe to bundle for the browser: no secrets, no Supabase, no server imports.
 */

export type FeatureFlag = "NEW_NAV_BAR";

/** What a flag is when nothing says otherwise. */
const FLAG_DEFAULTS: Record<FeatureFlag, boolean> = {
  /*
   * The 5-slot bar (Home / Inbox / Apsi / Sales / Business) is the shipped
   * navigation. Flipping this to false restores the previous Home / Inbox /
   * Resolve / Sales / More shell, which stays in the bundle for exactly that
   * reason — see BottomNav.
   */
  NEW_NAV_BAR: true,
};

const STORAGE_PREFIX = "apsa.flag.";

const TRUE_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

function parseFlagValue(raw: string | undefined | null): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "") return undefined;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return undefined;
}

/**
 * The env value for a flag.
 *
 * Read from both `import.meta.env` (browser bundle, injected by Vite) and
 * `process.env` (SSR and the test runner). They carry the same VITE_ values,
 * so whichever one exists in this runtime answers.
 */
function readFlagEnv(flag: FeatureFlag): boolean | undefined {
  const name = `VITE_${flag}`;
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromVite = parseFlagValue(viteEnv?.[name]);
  if (fromVite !== undefined) return fromVite;
  if (typeof process !== "undefined" && process.env) {
    return parseFlagValue(process.env[name]);
  }
  return undefined;
}

/**
 * The flag's value ignoring any per-browser override.
 *
 * This is what SSR renders, so it is also the snapshot the client must use for
 * its first paint — anything else is a hydration mismatch.
 */
export function featureFlagBaseline(flag: FeatureFlag): boolean {
  return readFlagEnv(flag) ?? FLAG_DEFAULTS[flag];
}

export function featureFlagStorageKey(flag: FeatureFlag): string {
  return `${STORAGE_PREFIX}${flag}`;
}

/**
 * The flag as it applies to this browser, override included.
 *
 * Never call this during render — it reads localStorage, which the server
 * cannot see. `useFeatureFlag` exists for components.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  if (typeof window !== "undefined") {
    try {
      const override = parseFlagValue(window.localStorage.getItem(featureFlagStorageKey(flag)));
      if (override !== undefined) return override;
    } catch {
      // Private mode, blocked storage, quota. The env default still answers.
    }
  }
  return featureFlagBaseline(flag);
}

/** Set or clear a per-browser override. `undefined` clears it. */
export function setFeatureFlagOverride(flag: FeatureFlag, value: boolean | undefined): void {
  if (typeof window === "undefined") return;
  try {
    const key = featureFlagStorageKey(flag);
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value ? "1" : "0");
    window.dispatchEvent(new Event(FLAG_CHANGE_EVENT));
  } catch {
    // Nothing to do: an override that cannot be stored simply does not apply.
  }
}

export const FLAG_CHANGE_EVENT = "apsa:feature-flag-change";
