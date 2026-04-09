"use client";

import { createContext, useContext, useEffect, useState } from "react";
import useAuthStore from "@/store/authStore";

const THEMES = ["dark", "light"];
const PALETTES = ["indigo", "cyan", "coral", "teal", "slate", "sage", "mauve"];
const PALETTE_COLORS = {
  indigo:  "#6366f1",
  cyan:    "#0891b2",
  coral:   "#c27060",
  teal:    "#5ba8a0",
  slate:   "#64748b",
  sage:    "#6b8f71",
  mauve:   "#8b7090",
};
const STYLES = ["default", "glass", "mono", "gradient"];

const ThemeContext = createContext({});

export function useTheme() {
  return useContext(ThemeContext);
}

function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.remove("dark", "high-contrast", "warm");
  if (theme === "dark") html.classList.add("dark");
  if (theme === "high-contrast") html.classList.add("dark", "high-contrast");
  if (theme === "warm") html.classList.add("warm");
}

function applyPalette(palette) {
  const html = document.documentElement;
  PALETTES.forEach((p) => html.classList.remove(`palette-${p}`));
  if (palette && palette !== "indigo") {
    html.classList.add(`palette-${palette}`);
  }
}

function applyStyle(style) {
  const html = document.documentElement;
  STYLES.forEach((s) => html.classList.remove(`style-${s}`));
  if (style && style !== "default") {
    html.classList.add(`style-${style}`);
  }
}

export default function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState("dark");
  const [palette, setPaletteState] = useState("indigo");
  const [style, setStyleState] = useState("default");
  const user = useAuthStore((s) => s.user);
  const updatePreferences = useAuthStore((s) => s.updatePreferences);

  useEffect(() => {
    const prefs = user?.preferences || {};
    const savedTheme = prefs.theme || localStorage.getItem("theme") || "dark";
    const savedPalette = prefs.palette || localStorage.getItem("palette") || "indigo";
    const savedStyle = prefs.style || localStorage.getItem("style") || "default";
    const validTheme = THEMES.includes(savedTheme) ? savedTheme : "dark";
    const validPalette = PALETTES.includes(savedPalette) ? savedPalette : "indigo";
    const validStyle = STYLES.includes(savedStyle) ? savedStyle : "default";
    setThemeState(validTheme);
    setPaletteState(validPalette);
    setStyleState(validStyle);
    applyTheme(validTheme);
    applyPalette(validPalette);
    applyStyle(validStyle);
    requestAnimationFrame(() => {
      document.documentElement.classList.add("theme-ready");
    });
  }, [user]);

  const setTheme = (t) => {
    const valid = THEMES.includes(t) ? t : "dark";
    setThemeState(valid);
    localStorage.setItem("theme", valid);
    applyTheme(valid);
    if (user) updatePreferences({ ...user.preferences, theme: valid });
  };

  const setPalette = (p) => {
    const valid = PALETTES.includes(p) ? p : "indigo";
    setPaletteState(valid);
    localStorage.setItem("palette", valid);
    applyPalette(valid);
    if (user) updatePreferences({ ...user.preferences, palette: valid });
  };

  const setStyle = (s) => {
    const valid = STYLES.includes(s) ? s : "default";
    setStyleState(valid);
    localStorage.setItem("style", valid);
    applyStyle(valid);
    if (user) updatePreferences({ ...user.preferences, style: valid });
  };

  const toggle = () => {
    const idx = THEMES.indexOf(theme);
    setTheme(THEMES[(idx + 1) % THEMES.length]);
  };

  return (
    <ThemeContext.Provider value={{
      theme, setTheme, toggle, themes: THEMES,
      palette, setPalette, palettes: PALETTES, paletteColors: PALETTE_COLORS,
      style, setStyle, styles: STYLES,
    }}>
      {children}
    </ThemeContext.Provider>
  );
}
