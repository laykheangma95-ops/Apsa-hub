/**
 * The language a render uses, resolved by the root route's beforeLoad.
 *
 * Server: from THIS request's language cookie (strictly validated, falling
 * back to Khmer). Nothing process-wide is read or written, so concurrent
 * requests cannot influence each other. The result reaches the browser in the
 * dehydrated route context, which is what the first hydration render uses.
 *
 * Client (client-side navigations only — hydration reuses the server value):
 * the language the browser is currently showing.
 */
import { createIsomorphicFn } from "@tanstack/react-start";
import type { Language } from "@/types";
import { currentClientLanguage } from "@/lib/i18n";
import { LANGUAGE_COOKIE, ssrLanguageFromCookie } from "@/lib/language";

export const getRequestLanguage = createIsomorphicFn()
  .server(async (): Promise<Language> => {
    const { getCookie } = await import("@tanstack/react-start/server");
    return ssrLanguageFromCookie(getCookie(LANGUAGE_COOKIE));
  })
  .client(async (): Promise<Language> => currentClientLanguage());
