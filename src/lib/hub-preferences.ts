import type { HubTilePreference } from "@/design-system/app-nav-config";

/**
 * A member's own arrangement of the Sales grid.
 *
 * Stored per principal in this browser. It is a preference about layout, so it
 * lives where a preference can be read without a round trip and lost without
 * consequence — and it can only ever hide or reorder tiles the capability
 * filter already allowed, never reveal one it did not.
 *
 * Known limit: this is per browser, not per account. A merchant who arranges
 * their grid on a phone and then opens APSA on a laptop sees the default
 * arrangement there. Making it follow the account needs a member-preferences
 * table and a server read, which belongs with the preferences work rather than
 * with the navigation shell.
 */
const PREFIX = "apsa.hub.sales";

function storageKey(userId: string, organizationId: string): string {
  return `${PREFIX}.${userId}.${organizationId}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function readSalesTilePreference(
  userId: string,
  organizationId: string,
): HubTilePreference | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(storageKey(userId, organizationId));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const preference: HubTilePreference = {};
    if (isStringArray(record["order"])) preference.order = record["order"];
    if (isStringArray(record["hidden"])) preference.hidden = record["hidden"];
    return preference;
  } catch {
    // Unparseable or unavailable storage means "no preference", never a crash.
    return undefined;
  }
}

export function writeSalesTilePreference(
  userId: string,
  organizationId: string,
  preference: HubTilePreference,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(userId, organizationId), JSON.stringify(preference));
  } catch {
    // A preference that cannot be stored simply does not persist.
  }
}

/** Move a tile one place along, keeping every other tile's relative order. */
export function moveTile(order: readonly string[], id: string, direction: -1 | 1): string[] {
  const next = [...order];
  const from = next.indexOf(id);
  if (from < 0) return next;
  const to = from + direction;
  if (to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
