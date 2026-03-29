"use client";

import { useState } from "react";
import { useTheme } from "@/components/layout/ThemeProvider";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { authAPI } from "@/lib/api";
import { clearToken } from "@/lib/auth";

const THEME_OPTIONS = [
  { value: "dark", labelKey: "themeDark", descKey: "themeDarkDesc" },
  { value: "light", labelKey: "themeLight", descKey: "themeLightDesc" },
  { value: "high-contrast", labelKey: "themeHighContrast", descKey: "themeHighContrastDesc" },
];

const LANG_OPTIONS = [
  { value: "zh", labelKey: "langZh" },
  { value: "en", labelKey: "langEn" },
];

export default function SettingsPage() {
  const { theme, setTheme, palette, setPalette, palettes, paletteColors, style, setStyle, styles } = useTheme();
  const { lang, setLang, t } = useLanguage();

  const [unForm, setUnForm] = useState({ newUsername: "", currentPassword: "" });
  const [unError, setUnError] = useState("");
  const [unLoading, setUnLoading] = useState(false);

  async function handleChangeUsername(e) {
    e.preventDefault();
    setUnError("");
    setUnLoading(true);
    try {
      await authAPI.changeUsername(unForm);
      clearToken();
      window.location.href = "/login";
    } catch (err) {
      const msg = err.response?.data?.error?.message || "";
      if (msg.toLowerCase().includes("incorrect")) {
        setUnError(t("currentPasswordIncorrect"));
      } else if (msg.toLowerCase().includes("already exists")) {
        setUnError(t("usernameExistsError"));
      } else {
        setUnError(t("changeUsernameFailed"));
      }
    } finally {
      setUnLoading(false);
    }
  }

  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "", confirmNewPassword: "" });
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);

  async function handleChangePassword(e) {
    e.preventDefault();
    setPwError("");
    setPwSuccess(false);

    if (pwForm.newPassword.length < 8) {
      setPwError(t("newPasswordMin"));
      return;
    }
    if (pwForm.newPassword !== pwForm.confirmNewPassword) {
      setPwError(t("newPasswordsMismatch"));
      return;
    }

    setPwLoading(true);
    try {
      await authAPI.changePassword({
        currentPassword: pwForm.currentPassword,
        newPassword: pwForm.newPassword,
      });
      setPwSuccess(true);
      setPwForm({ currentPassword: "", newPassword: "", confirmNewPassword: "" });
    } catch (err) {
      const msg = err.response?.data?.error?.message || "";
      if (msg.toLowerCase().includes("incorrect")) {
        setPwError(t("currentPasswordIncorrect"));
      } else {
        setPwError(t("changePasswordFailed"));
      }
    } finally {
      setPwLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-theme">{t("settings")}</h1>
        <p className="mt-1 text-sm text-muted">{t("customizeExperience")}</p>
      </div>

      <div className="space-y-6">
        {/* Language */}
        <div className="rounded-xl border border-border bg-surface p-6">
          <p className="mb-4 text-sm font-semibold text-theme">{t("language")}</p>
          <div className="flex gap-2">
            {LANG_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setLang(opt.value)}
                className={`flex-1 rounded-lg border px-4 py-3 text-center text-sm font-medium transition-colors ${
                  lang === opt.value
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-surface-hover text-theme"
                }`}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Appearance */}
        <div className="rounded-xl border border-border bg-surface p-6">
          <p className="mb-4 text-sm font-semibold text-theme">{t("appearance")}</p>
          <div className="flex flex-col gap-2">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setTheme(opt.value)}
                className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
                  theme === opt.value
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-surface-hover"
                }`}
              >
                <div>
                  <p className={`text-sm font-medium ${theme === opt.value ? "text-primary" : "text-theme"}`}>
                    {t(opt.labelKey)}
                  </p>
                  <p className="text-xs text-muted">{t(opt.descKey)}</p>
                </div>
                {theme === opt.value && (
                  <span className="text-sm text-primary">{t("active")}</span>
                )}
              </button>
            ))}
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <p className="mb-3 text-sm font-semibold text-theme">{t("colorPalette")}</p>
            <div className="flex gap-3">
              {palettes.map((p) => (
                <button
                  key={p}
                  onClick={() => setPalette(p)}
                  className="h-8 w-8 rounded-full transition-transform hover:scale-110"
                  style={{
                    background: paletteColors[p],
                    outline: palette === p ? "3px solid var(--text)" : "none",
                    outlineOffset: "3px",
                  }}
                  title={p}
                />
              ))}
            </div>
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <p className="mb-3 text-sm font-semibold text-theme">{t("surfaceStyle")}</p>
            <div className="flex gap-2">
              {styles.map((s) => (
                <button
                  key={s}
                  onClick={() => setStyle(s)}
                  className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                    style === s
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-surface-hover text-theme"
                  }`}
                >
                  {t(`style_${s}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
        {/* Change Username */}
        <div className="rounded-xl border border-border bg-surface p-6">
          <p className="mb-1 text-sm font-semibold text-theme">{t("changeUsername")}</p>
          <p className="mb-4 text-xs text-muted">{t("changeUsernameNote")}</p>
          <form onSubmit={handleChangeUsername} className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted">{t("newUsername")}</label>
              <input
                type="text"
                value={unForm.newUsername}
                onChange={(e) => setUnForm((f) => ({ ...f, newUsername: e.target.value }))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme focus:outline-none focus:ring-2 focus:ring-primary"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted">{t("passwordConfirm")}</label>
              <input
                type="password"
                value={unForm.currentPassword}
                onChange={(e) => setUnForm((f) => ({ ...f, currentPassword: e.target.value }))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme focus:outline-none focus:ring-2 focus:ring-primary"
                required
              />
            </div>
            {unError && <p className="text-xs text-red-400">{unError}</p>}
            <button
              type="submit"
              disabled={unLoading}
              className="mt-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {unLoading ? t("changingUsername") : t("changeUsername")}
            </button>
          </form>
        </div>

        {/* Change Password */}
        <div className="rounded-xl border border-border bg-surface p-6">
          <p className="mb-4 text-sm font-semibold text-theme">{t("changePassword")}</p>
          <form onSubmit={handleChangePassword} className="flex flex-col gap-3">
            {[
              { key: "currentPassword", label: t("currentPassword") },
              { key: "newPassword", label: t("newPassword") },
              { key: "confirmNewPassword", label: t("confirmNewPassword") },
            ].map(({ key, label }) => (
              <div key={key}>
                <label className="mb-1 block text-xs text-muted">{label}</label>
                <input
                  type="password"
                  value={pwForm[key]}
                  onChange={(e) => setPwForm((f) => ({ ...f, [key]: e.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme focus:outline-none focus:ring-2 focus:ring-primary"
                  required
                />
              </div>
            ))}
            {pwError && <p className="text-xs text-red-400">{pwError}</p>}
            {pwSuccess && <p className="text-xs text-green-400">{t("changePasswordSuccess")}</p>}
            <button
              type="submit"
              disabled={pwLoading}
              className="mt-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {pwLoading ? t("changingPassword") : t("changePassword")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
