/**
 * Language preference — the pure rules, with no React and no i18next.
 *
 * The invariant this module serves: the server's first render and the
 * browser's first hydration render use the SAME language. The server can only
 * honour a preference it can see, so the preference lives in a cookie
 * (`apsa_language`). That cookie is the authority for SSR; localStorage is
 * kept in step for compatibility and is read only after hydration, to migrate
 * browsers that saved a preference before the cookie existed.
 *
 * The cookie is a non-sensitive UI preference: its value is exactly "km" or
 * "en". It never carries a user, organization, token or anything personal.
 */
import type { Language } from "@/types";

/** Khmer is the default. English is the toggle. */
export const DEFAULT_LANGUAGE: Language = "km";

/** Server-visible preference. Value is exactly "km" or "en". */
export const LANGUAGE_COOKIE = "apsa_language";

/** Legacy browser-only preference, kept in step with the cookie. */
export const LANGUAGE_STORAGE_KEY = "apsa.language";

/** One year: a display preference, not a credential. */
export const LANGUAGE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Strict: only the exact strings "km" and "en" are languages. */
export function parseLanguage(value: unknown): Language | null {
  return value === "km" || value === "en" ? value : null;
}

/** The language the server renders for a request carrying this cookie value. */
export function ssrLanguageFromCookie(cookieValue: unknown): Language {
  return parseLanguage(cookieValue) ?? DEFAULT_LANGUAGE;
}

/** Reads one cookie's raw value from a `Cookie` header / `document.cookie`. */
export function readCookieValue(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * The `document.cookie` assignment that persists a language. Readable by the
 * page (the page writes it), Lax, whole-site, Secure on HTTPS.
 */
export function serializeLanguageCookie(language: Language, options: { secure: boolean }): string {
  return [
    `${LANGUAGE_COOKIE}=${language}`,
    "Path=/",
    `Max-Age=${LANGUAGE_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * The language a browser settles on once hydration is complete.
 *
 * Precedence (highest first):
 *   1. a valid cookie            — what the server rendered from, authoritative
 *   2. a valid legacy localStorage value — a preference saved before the cookie
 *   3. the language already rendered (the SSR default)
 *
 * Invalid values at any level are ignored, never coerced.
 */
export function resolveSettledLanguage(input: {
  cookie: unknown;
  stored: unknown;
  rendered: Language;
}): Language {
  return parseLanguage(input.cookie) ?? parseLanguage(input.stored) ?? input.rendered;
}
