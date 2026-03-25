"use client";

import { createContext, useContext, useEffect, useState } from "react";
import locales from "@/i18n";
import useAuthStore from "@/store/authStore";

const LANGUAGES = ["zh", "en"];
const DEFAULT_LANG = "zh";

const LanguageContext = createContext({ lang: DEFAULT_LANG, t: (k) => k, setLang: () => {} });

export function useLanguage() {
  return useContext(LanguageContext);
}

export default function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(DEFAULT_LANG);
  const user = useAuthStore((s) => s.user);
  const updatePreferences = useAuthStore((s) => s.updatePreferences);

  // Initialize from user preferences (if logged in) or localStorage
  useEffect(() => {
    const userLang = user?.preferences?.language;
    const saved = userLang || localStorage.getItem("lang") || DEFAULT_LANG;
    const valid = LANGUAGES.includes(saved) ? saved : DEFAULT_LANG;
    setLangState(valid);
    document.documentElement.lang = valid === "zh" ? "zh-CN" : "en";
  }, [user]);

  const setLang = (l) => {
    const valid = LANGUAGES.includes(l) ? l : DEFAULT_LANG;
    setLangState(valid);
    localStorage.setItem("lang", valid);
    document.documentElement.lang = valid === "zh" ? "zh-CN" : "en";
    // Persist to DB if logged in
    if (user) {
      updatePreferences({ ...user.preferences, language: valid });
    }
  };

  const t = (key) => {
    return locales[lang]?.[key] ?? locales.en?.[key] ?? key;
  };

  return (
    <LanguageContext.Provider value={{ lang, setLang, t, languages: LANGUAGES }}>
      {children}
    </LanguageContext.Provider>
  );
}
