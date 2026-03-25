/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Semantic surface tokens
        background: "var(--background)",
        surface: "var(--surface)",
        "surface-hover": "var(--surface-hover)",
        border: "var(--border)",

        // Brand
        primary: "var(--primary)",
        "primary-hover": "var(--primary-hover)",
        accent: "var(--accent)",

        // Text
        muted: "var(--muted)",
        "text-primary": "var(--text)",
        "text-secondary": "var(--text-secondary)",
        "on-primary": "var(--text-on-primary)",

        // Status
        danger: "var(--danger)",
        success: "var(--success)",
        warning: "var(--warning)",

        // Input
        "input-bg": "var(--input-bg)",
        "slider-track": "var(--slider-track)",
      },
      boxShadow: {
        "theme-sm": "0 1px 2px var(--shadow)",
        "theme-md": "0 4px 6px var(--shadow)",
        "theme-lg": "0 10px 15px var(--shadow)",
      },
    },
  },
  plugins: [],
};
