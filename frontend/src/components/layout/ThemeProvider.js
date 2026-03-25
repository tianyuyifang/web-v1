"use client";

import { createContext, useContext, useEffect, useState } from "react";
import useAuthStore from "@/store/authStore";

const THEMES = ["dark", "light", "high-contrast"];

const ThemeContext = createContext({ theme: "dark", setTheme: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.remove("dark", "high-contrast");
  if (theme === "dark") html.classList.add("dark");
  if (theme === "high-contrast") html.classList.add("dark", "high-contrast");
}

export default function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState("dark");
  const user = useAuthStore((s) => s.user);
  const updatePreferences = useAuthStore((s) => s.updatePreferences);

  // Initialize from user preferences (if logged in) or localStorage
  useEffect(() => {
    const userTheme = user?.preferences?.theme;
    const saved = userTheme || localStorage.getItem("theme") || "dark";
    const valid = THEMES.includes(saved) ? saved : "dark";
    setThemeState(valid);
    applyTheme(valid);
    // Enable transitions only after initial theme is applied (avoids paint thrashing)
    requestAnimationFrame(() => {
      document.documentElement.classList.add("theme-ready");
    });
  }, [user]);

  const setTheme = (t) => {
    const valid = THEMES.includes(t) ? t : "dark";
    setThemeState(valid);
    localStorage.setItem("theme", valid);
    applyTheme(valid);
    // Persist to DB if logged in
    if (user) {
      updatePreferences({ ...user.preferences, theme: valid });
    }
  };

  // Legacy toggle for backwards compat
  const toggle = () => {
    const idx = THEMES.indexOf(theme);
    setTheme(THEMES[(idx + 1) % THEMES.length]);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
}
