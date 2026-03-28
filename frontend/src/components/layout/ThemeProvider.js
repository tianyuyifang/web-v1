"use client";

import { createContext, useContext, useEffect, useState } from "react";
import useAuthStore from "@/store/authStore";

const THEMES = ["dark", "light", "high-contrast"];
const PALETTES = ["indigo", "rose", "emerald", "amber", "cyan", "violet"];
const PALETTE_COLORS = {
  indigo: "#6366f1",
  rose: "#e11d48",
  emerald: "#059669",
  amber: "#d97706",
  cyan: "#0891b2",
  violet: "#7c3aed",
};

const ThemeContext = createContext({ theme: "dark", palette: "indigo", setTheme: () => {}, setPalette: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.remove("dark", "high-contrast");
  if (theme === "dark") html.classList.add("dark");
  if (theme === "high-contrast") html.classList.add("dark", "high-contrast");
}

function applyPalette(palette) {
  const html = document.documentElement;
  PALETTES.forEach((p) => html.classList.remove(`palette-${p}`));
  if (palette && palette !== "indigo") {
    html.classList.add(`palette-${palette}`);
  }
}

export default function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState("dark");
  const [palette, setPaletteState] = useState("indigo");
  const user = useAuthStore((s) => s.user);
  const updatePreferences = useAuthStore((s) => s.updatePreferences);

  // Initialize from user preferences (if logged in) or localStorage
  useEffect(() => {
    const prefs = user?.preferences || {};
    const savedTheme = prefs.theme || localStorage.getItem("theme") || "dark";
    const savedPalette = prefs.palette || localStorage.getItem("palette") || "indigo";
    const validTheme = THEMES.includes(savedTheme) ? savedTheme : "dark";
    const validPalette = PALETTES.includes(savedPalette) ? savedPalette : "indigo";
    setThemeState(validTheme);
    setPaletteState(validPalette);
    applyTheme(validTheme);
    applyPalette(validPalette);
    requestAnimationFrame(() => {
      document.documentElement.classList.add("theme-ready");
    });
  }, [user]);

  const setTheme = (t) => {
    const valid = THEMES.includes(t) ? t : "dark";
    setThemeState(valid);
    localStorage.setItem("theme", valid);
    applyTheme(valid);
    if (user) {
      updatePreferences({ ...user.preferences, theme: valid });
    }
  };

  const setPalette = (p) => {
    const valid = PALETTES.includes(p) ? p : "indigo";
    setPaletteState(valid);
    localStorage.setItem("palette", valid);
    applyPalette(valid);
    if (user) {
      updatePreferences({ ...user.preferences, palette: valid });
    }
  };

  const toggle = () => {
    const idx = THEMES.indexOf(theme);
    setTheme(THEMES[(idx + 1) % THEMES.length]);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle, themes: THEMES, palette, setPalette, palettes: PALETTES, paletteColors: PALETTE_COLORS }}>
      {children}
    </ThemeContext.Provider>
  );
}
