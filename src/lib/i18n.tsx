import i18n, { type i18n as I18nInstance, type InitOptions } from "i18next";
import { I18nextProvider, initReactI18next, useTranslation } from "react-i18next";
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import km from "@/locales/km.json";
import en from "@/locales/en.json";
import type { Language } from "@/types";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  LANGUAGE_STORAGE_KEY,
  parseLanguage,
  readCookieValue,
  resolveSettledLanguage,
  serializeLanguageCookie,
} from "@/lib/language";

export { DEFAULT_LANGUAGE };

function i18nOptions(lng: Language): InitOptions {
  return {
    resources: {
      km: { translation: km },
      en: { translation: en },
    },
    lng,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    // Initialize synchronously so SSR and the first client render match.
    initAsync: false,
  };
}

/*
 * The global instance. React UI does NOT render from it — LanguageProvider
 * gives the tree its own instances. It remains for code outside a React
 * render (client-side head() fallbacks, components tested without the
 * provider) and is kept in step with the provider's language on the client.
 * On the server it is never switched: concurrent requests must not share a
 * mutable language.
 */
if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init(i18nOptions(DEFAULT_LANGUAGE));
}

/**
 * A fresh, isolated instance fixed to one language. LanguageProvider never
 * calls changeLanguage() on it: switching language means switching instance,
 * so a value React has already rendered from can never change underneath a
 * render that is still hydrating — and on the server, no request can see
 * another request's language.
 */
export function createI18nInstance(lng: Language): I18nInstance {
  const instance = i18n.createInstance();
  void instance.init(i18nOptions(lng));
  return instance;
}

/**
 * A translate function for route `head()`, bound to the request's language
 * (route context `language`, set by the root route). Pure: getFixedT does
 * not change any instance's language.
 */
export function headTranslator(language: unknown) {
  return i18n.getFixedT(parseLanguage(language) ?? DEFAULT_LANGUAGE);
}

/** The language the browser currently shows (client-side root beforeLoad). */
export function currentClientLanguage(): Language {
  return parseLanguage(i18n.language) ?? DEFAULT_LANGUAGE;
}

function readStoredLanguage(): unknown {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persists both the server-visible cookie and the legacy browser value. */
function persistLanguage(lang: Language): void {
  document.cookie = serializeLanguageCookie(lang, {
    secure: window.location.protocol === "https:",
  });
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // Storage blocked (private mode): the cookie alone still carries it.
  }
}

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  toggleLanguage: () => void;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: DEFAULT_LANGUAGE,
  setLanguage: () => {},
  toggleLanguage: () => {},
});

/**
 * `initialLanguage` is the language the server rendered: the root route
 * resolves it from the language cookie on the server, and the browser receives
 * the same value in the dehydrated route context. The first client render
 * therefore matches the server HTML exactly.
 *
 * Nothing changes the rendered language during hydration. Only after the
 * first commit does the provider look at stored preferences (a legacy
 * localStorage value from before the cookie existed) — and any resulting
 * switch is a transition onto a different instance, which React applies only
 * once every still-dehydrated Suspense boundary has hydrated with the
 * server's language.
 */
export function LanguageProvider({
  initialLanguage,
  children,
}: {
  initialLanguage: Language;
  children: ReactNode;
}) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  // One instance per language for this provider — per request on the server.
  const [instances] = useState(() => new Map<Language, I18nInstance>());
  let instance = instances.get(language);
  if (!instance) {
    instance = createI18nInstance(language);
    instances.set(language, instance);
  }

  const switchTo = useCallback((lang: Language) => {
    startTransition(() => setLanguageState(lang));
  }, []);

  // Post-hydration only: settle on cookie → legacy localStorage → rendered.
  useEffect(() => {
    const settled = resolveSettledLanguage({
      cookie: readCookieValue(document.cookie, LANGUAGE_COOKIE),
      stored: readStoredLanguage(),
      rendered: initialLanguage,
    });
    persistLanguage(settled);
    if (settled !== initialLanguage) switchTo(settled);
    // Mount only: initialLanguage is the SSR language and never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the global instance in step for code outside a React render.
  useEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language);
  }, [language]);

  const setLanguage = useCallback(
    (lang: Language) => {
      persistLanguage(lang);
      switchTo(lang);
    },
    [switchTo],
  );

  const toggleLanguage = useCallback(() => {
    setLanguage(language === "km" ? "en" : "km");
  }, [language, setLanguage]);

  return (
    <I18nextProvider i18n={instance}>
      <LanguageContext.Provider value={{ language, setLanguage, toggleLanguage }}>
        {children}
      </LanguageContext.Provider>
    </I18nextProvider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}

export { useTranslation };
export default i18n;
