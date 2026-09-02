import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import km from "@/locales/km.json";
import en from "@/locales/en.json";
import type { Language } from "@/types";

/** Khmer is the default. English is the toggle. */
export const DEFAULT_LANGUAGE: Language = "km";

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: {
      km: { translation: km },
      en: { translation: en },
    },
    lng: DEFAULT_LANGUAGE,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}

const STORAGE_KEY = "apsa.language";

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

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(DEFAULT_LANGUAGE);

  const apply = useCallback((lang: Language) => {
    setLanguageState(lang);
    void i18n.changeLanguage(lang);
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-lang", lang);
      document.documentElement.setAttribute("lang", lang);
    }
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) as Language | null;
    apply(stored === "en" || stored === "km" ? stored : DEFAULT_LANGUAGE);
  }, [apply]);

  const setLanguage = useCallback(
    (lang: Language) => {
      apply(lang);
      window.localStorage.setItem(STORAGE_KEY, lang);
    },
    [apply],
  );

  const toggleLanguage = useCallback(() => {
    setLanguage(language === "km" ? "en" : "km");
  }, [language, setLanguage]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, toggleLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}

export { useTranslation };
export default i18n;
