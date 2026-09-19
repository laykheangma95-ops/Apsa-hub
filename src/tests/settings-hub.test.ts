/**
 * Settings Hub redesign — regression coverage for src/routes/app.settings.tsx.
 *
 * The Settings screen was restructured from a long read-only account/business
 * form into a navigational hub (compact rows that open detail sheets), per
 * the APSA Settings Hub plan. These are source-level structural checks — this
 * codebase has no React Testing Library / DOM renderer for routes, so "UI
 * wiring" is verified the same way settings-business-update.test.ts already
 * does: reading the real route file and asserting on it directly, not a
 * source-string/grep guess.
 *
 * Run: bun test src/tests/settings-hub.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import en from "../locales/en.json";
import km from "../locales/km.json";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), "utf-8");
const SOURCE = read("src/routes/app.settings.tsx");

/**
 * Slices the SettingsScreen() function body out of the route source (it is
 * the last function in the file), so hub-level assertions — "the big
 * read-only blocks are gone from the hub" — can't be satisfied by a detail
 * sheet living in a different component earlier in the same file.
 */
function settingsScreenBody(source: string): string {
  const start = source.indexOf("function SettingsScreen()");
  if (start === -1) throw new Error("SettingsScreen() not found in app.settings.tsx");
  return source.slice(start);
}

function getPath(tree: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      tree,
    );
}

describe("Settings hub — real destinations preserved", () => {
  it("Business Profile row exists, gated on organization.read, opens a detail sheet", () => {
    expect(SOURCE).toContain('capabilities.can("organization.read")');
    expect(SOURCE).toContain('t("settings.business.rowLabel")');
    expect(SOURCE).toContain("if (!canRead) return null;");
    expect(SOURCE).toContain("setDetailOpen(true)");
  });

  it("Business edit stays gated on organization.update, distinct from the read gate", () => {
    expect(SOURCE).toContain('capabilities.can("organization.update")');
    expect(SOURCE).toContain('canEdit && view.kind === "ready"');
  });

  it("editing still writes straight into the read query's cache — no stale name after save", () => {
    expect(SOURCE).toContain("queryClient.setQueryData(ORGANIZATION_PROFILE_QUERY_KEY, updated)");
    expect(SOURCE).toContain("queryKey: ORGANIZATION_PROFILE_QUERY_KEY");
  });

  it("Account & Profile row exists and reads the real account-profile query", () => {
    expect(SOURCE).toContain('t("settings.account.rowLabel")');
    expect(SOURCE).toContain('queryKey: ["settings", "account-profile"]');
    expect(SOURCE).toContain("getAccountProfileFn()");
  });

  it("Team remains reachable when permitted, gated on team.read, navigating to /app/team", () => {
    expect(SOURCE).toContain('capabilities.can("team.read")');
    expect(SOURCE).toContain('if (!capabilities.can("team.read")) return null;');
    expect(SOURCE).toContain('to: "/app/team"');
  });

  it("Language row still uses useLanguage() for persistence, with both Khmer and English segments", () => {
    expect(SOURCE).toContain("useLanguage()");
    expect(SOURCE).toContain('{ value: "km", label: "ខ្មែរ" }');
    expect(SOURCE).toContain('{ value: "en", label: "English" }');
    expect(SOURCE).toContain("setLanguage(next)");
  });

  it("Sign-out remains reachable from Security, through the same confirm flow", () => {
    expect(SOURCE).toContain("signOutFn()");
    expect(SOURCE).toContain('t("settings.security.signOutConfirmTitle")');
    expect(SOURCE).toContain('t("settings.security.signOutConfirmAction")');
  });
});

describe("Settings hub — old read-only blocks are gone from the hub itself", () => {
  const hubBody = settingsScreenBody(SOURCE);

  it("SettingsScreen no longer renders business slug/type/currency/country directly", () => {
    expect(hubBody).not.toContain("settings.business.slug");
    expect(hubBody).not.toContain("settings.business.currency");
    expect(hubBody).not.toContain("settings.business.country");
    expect(hubBody).not.toContain("settings.business.type");
  });

  it("SettingsScreen no longer renders account email/name directly", () => {
    expect(hubBody).not.toContain("settings.account.email");
    expect(hubBody).not.toContain("settings.account.name");
  });

  it("SettingsScreen renders compact grouped rows instead — Business, Personal, Security & Access", () => {
    expect(hubBody).toContain('t("settings.section.business")');
    expect(hubBody).toContain('t("settings.section.personal")');
    expect(hubBody).toContain('t("settings.section.securityAccess")');
  });
});

describe("Settings hub — real data only, no fake destinations", () => {
  it("declares no Notifications, Help & Support, or About APSA section (no real functionality backs them)", () => {
    const settingsKeys = Object.keys((en as Record<string, unknown>).settings as object);
    expect(settingsKeys).not.toContain("notifications");
    expect(settingsKeys).not.toContain("help");
    expect(settingsKeys).not.toContain("about");
    expect(settingsKeys).not.toContain("support");
  });

  it("never invents a member count, plan name, setup score, or completeness indicator", () => {
    expect(SOURCE).not.toMatch(/memberCount|planName|setupScore|completeness/i);
  });
});

describe("Settings hub — BottomNav clearance unchanged", () => {
  it("still uses the measured nav clearance system, never a hand-tuned bottom padding", () => {
    expect(SOURCE).toContain('bottom="nav"');
    expect(SOURCE).toContain("<BottomNav");
    expect(SOURCE).not.toMatch(/paddingBottom:\s*["']?\d/);
  });
});

describe("Settings hub — secondary values truncate safely", () => {
  it("Business Profile and Account & Profile pass descriptionClassName to truncate a long name/email", () => {
    const truncateCount = (SOURCE.match(/descriptionClassName="truncate"/g) ?? []).length;
    expect(truncateCount).toBeGreaterThanOrEqual(2);
  });
});

describe("Settings hub — i18n parity for the new hub keys", () => {
  const NEW_KEYS = [
    "settings.section.personal",
    "settings.section.securityAccess",
    "settings.business.rowLabel",
    "settings.account.rowLabel",
    "settings.team.label",
  ];

  for (const key of NEW_KEYS) {
    it(`${key} exists in both English and Khmer`, () => {
      expect(typeof getPath(en, key)).toBe("string");
      expect(typeof getPath(km, key)).toBe("string");
    });
  }
});
