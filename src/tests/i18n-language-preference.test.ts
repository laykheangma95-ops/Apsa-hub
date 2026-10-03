/**
 * Language preference rules behind the hydration #418 repair: strict cookie
 * values, deterministic SSR fallback, post-hydration precedence, cookie
 * attributes, and request-bound head() titles.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import km from "@/locales/km.json";
import en from "@/locales/en.json";
import i18n, { createI18nInstance, headTranslator } from "@/lib/i18n";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  LANGUAGE_COOKIE_MAX_AGE_SECONDS,
  parseLanguage,
  readCookieValue,
  resolveSettledLanguage,
  serializeLanguageCookie,
  ssrLanguageFromCookie,
} from "@/lib/language";

const root = path.resolve(import.meta.dir, "../..");
const source = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("parseLanguage / ssrLanguageFromCookie", () => {
  it("accepts exactly km and en", () => {
    expect(parseLanguage("km")).toBe("km");
    expect(parseLanguage("en")).toBe("en");
  });

  it("rejects everything else, never coercing", () => {
    for (const bad of [
      "",
      "EN",
      "Km",
      " en",
      "en ",
      "fr",
      "english",
      "null",
      "undefined",
      null,
      undefined,
      1,
      {},
      ["en"],
    ]) {
      expect(parseLanguage(bad)).toBeNull();
    }
  });

  it("F. SSR falls back to Khmer for a missing or invalid cookie", () => {
    expect(DEFAULT_LANGUAGE).toBe("km");
    expect(ssrLanguageFromCookie(undefined)).toBe("km");
    expect(ssrLanguageFromCookie("EN")).toBe("km");
    expect(ssrLanguageFromCookie("<script>")).toBe("km");
    expect(ssrLanguageFromCookie("en")).toBe("en");
  });
});

describe("readCookieValue", () => {
  it("finds the language cookie among others, by exact name", () => {
    expect(readCookieValue("a=1; apsa_language=en; b=2", LANGUAGE_COOKIE)).toBe("en");
    expect(readCookieValue("xapsa_language=en; apsa_language=km", LANGUAGE_COOKIE)).toBe("km");
    expect(readCookieValue("apsa_language_old=en", LANGUAGE_COOKIE)).toBeNull();
    expect(readCookieValue("", LANGUAGE_COOKIE)).toBeNull();
    expect(readCookieValue(undefined, LANGUAGE_COOKIE)).toBeNull();
    expect(readCookieValue("apsa_language=%E0%A4", LANGUAGE_COOKIE)).toBe("%E0%A4");
  });
});

describe("resolveSettledLanguage — precedence: cookie → legacy localStorage → rendered", () => {
  const cases: Array<[string, unknown, unknown, "km" | "en", "km" | "en"]> = [
    ["legacy en + no cookie", null, "en", "km", "en"],
    ["legacy km + no cookie", null, "km", "km", "km"],
    ["cookie en + localStorage km", "en", "km", "en", "en"],
    ["cookie km + localStorage en", "km", "en", "km", "km"],
    ["invalid cookie, no storage", "EN", null, "km", "km"],
    ["invalid cookie, legacy en", "fr", "en", "km", "en"],
    ["G. invalid localStorage", null, "english", "km", "km"],
    ["G. invalid localStorage, cookie en", "en", "xx", "en", "en"],
    ["neither present", null, null, "km", "km"],
  ];
  for (const [name, cookie, stored, rendered, expected] of cases) {
    it(name, () => {
      expect(resolveSettledLanguage({ cookie, stored, rendered })).toBe(expected);
    });
  }
});

describe("language cookie", () => {
  it("carries only the language, with preference-appropriate attributes", () => {
    const http = serializeLanguageCookie("en", { secure: false });
    expect(http).toBe(
      `apsa_language=en; Path=/; Max-Age=${LANGUAGE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`,
    );
    expect(serializeLanguageCookie("km", { secure: true })).toEndWith("; Secure");
    // Never a credential: no user, organization, token or domain widening.
    expect(http).not.toMatch(/user|org|token|session|Domain=/i);
  });

  it("is distinct from every auth cookie", () => {
    const auth = source("src/api/auth.ts");
    const authNames = [...auth.matchAll(/COOKIE_[A-Z_]+\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(authNames.length).toBeGreaterThan(0);
    expect(authNames).not.toContain(LANGUAGE_COOKIE);
  });
});

describe("per-request i18n instances", () => {
  it("are isolated from each other and from the global instance", () => {
    const globalBefore = i18n.language;
    const a = createI18nInstance("en");
    const b = createI18nInstance("km");
    expect(a).not.toBe(b);
    expect(a).not.toBe(i18n);
    expect(a.t("auth.signIn.head.title")).toBe(en.auth.signIn.head.title);
    expect(b.t("auth.signIn.head.title")).toBe(km.auth.signIn.head.title);
    expect(a.isInitialized && b.isInitialized).toBe(true); // synchronous init
    expect(i18n.language).toBe(globalBefore);
  });

  it("headTranslator binds to the request language without switching any instance", () => {
    const before = i18n.language;
    expect(headTranslator("en")("landing.head.title")).toBe(en.landing.head.title);
    expect(headTranslator("km")("landing.head.title")).toBe(km.landing.head.title);
    expect(headTranslator("garbage")("landing.head.title")).toBe(km.landing.head.title);
    expect(i18n.language).toBe(before);
  });
});

describe("source guards", () => {
  it("the root document takes lang/data-lang from the render language — never a hard-coded value", () => {
    const rootSrc = source("src/routes/__root.tsx");
    expect(rootSrc).toContain("<html lang={language} data-lang={language}>");
    expect(rootSrc).not.toContain('<html lang="km"');
    expect(rootSrc).toContain("beforeLoad: async () => ({ language: await getRequestLanguage() })");
  });

  it("the repair does not hide the error", () => {
    for (const rel of ["src/routes/__root.tsx", "src/lib/i18n.tsx"]) {
      expect(source(rel)).not.toContain("suppressHydrationWarning");
    }
  });

  it("no route head() translates through the global instance", () => {
    const routesDir = path.join(root, "src/routes");
    for (const file of readdirSync(routesDir)) {
      if (!file.endsWith(".tsx")) continue;
      expect({ file, uses: /\bi18n\.t\(/.test(source(`src/routes/${file}`)) }).toEqual({
        file,
        uses: false,
      });
    }
  });
});
