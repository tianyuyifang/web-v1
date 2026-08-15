"use client";

import { createContext, useContext, useEffect } from "react";
import zh from "@/i18n/zh";

/**
 * The app is Chinese-only. This stays a provider rather than a bare import so
 * the ~500 existing `t("key")` call sites keep working untouched, and so a
 * second language could return without threading a hook back through them.
 */
const LanguageContext = createContext({ t: (k) => k });

export function useLanguage() {
  return useContext(LanguageContext);
}

const t = (key) => zh[key] ?? key;

export default function LanguageProvider({ children }) {
  useEffect(() => {
    document.documentElement.lang = "zh-CN";
  }, []);

  return (
    <LanguageContext.Provider value={{ t }}>
      {children}
    </LanguageContext.Provider>
  );
}
