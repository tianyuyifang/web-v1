"use client";

import { useMemo, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import useAuth from "@/hooks/useAuth";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { useTheme } from "@/components/layout/ThemeProvider";
import { authAPI, playlistsAPI } from "@/lib/api";
import { clearToken } from "@/lib/auth";
import ContactAdmins from "@/components/account/ContactAdmins";

/** Mirrors GUEST_PLAYLIST_LIMIT on the server. */
const GUEST_PLAYLIST_LIMIT = 3;

const THEME_OPTIONS = [
  { value: "dark", labelKey: "themeDark", descKey: "themeDarkDesc" },
  { value: "light", labelKey: "themeLight", descKey: "themeLightDesc" },
];

const LANG_OPTIONS = [
  { value: "zh", labelKey: "langZh" },
  { value: "en", labelKey: "langEn" },
];

/** One line in the guest permission list: a tick or a cross, plus a note. */
function PermissionRow({ allowed = false, label, note }) {
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="flex items-center gap-2">
        <span className={allowed ? "text-green-400" : "text-muted"}>
          {allowed ? "✓" : "✗"}
        </span>
        <span className={allowed ? "text-theme" : "text-muted"}>{label}</span>
      </span>
      {note && <span className="shrink-0 text-xs text-muted">{note}</span>}
    </li>
  );
}

export default function AccountPage() {
  const { user, loading, logout, isGuest } = useAuth();
  const { t, lang, setLang } = useLanguage();
  const { theme, setTheme, palette, setPalette, palettes, paletteColors, style, setStyle, styles } = useTheme();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("info"); // info | change | appearance | language

  // How many playlists the guest already owns — the number they care about
  // most. Only fetched for guests; nobody else has a cap to show.
  const [ownedCount, setOwnedCount] = useState(null);
  useEffect(() => {
    if (!isGuest) return;
    let alive = true;
    playlistsAPI
      .list()
      .then((res) => {
        if (!alive) return;
        const all = res.data?.playlists || [];
        setOwnedCount(all.filter((p) => p.isOwner).length);
      })
      .catch(() => {}); // the card still reads fine without the count
    return () => { alive = false; };
  }, [isGuest]);

  const daysInfo = useMemo(() => {
    if (!user?.expiresAt) return null;
    const ms = new Date(user.expiresAt).getTime() - Date.now();
    const days = Math.round(Math.abs(ms) / (24 * 60 * 60 * 1000));
    return ms >= 0
      ? t("daysLeft").replace("{n}", days)
      : t("expiredAgo").replace("{n}", days);
  }, [user, t]);

  // --- Change username ---
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

  // --- Change password ---
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

  function handleLogout() {
    logout();
    router.push("/login");
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!user) return null;

  const expired = user.status === "expired";

  const roleBadge = {
    GUEST: { label: t("roleGuest"), className: "bg-sky-500/15 text-sky-400" },
    MEMBER: { label: t("roleMember"), className: "bg-green-500/15 text-green-400" },
    ADMIN: { label: t("roleAdmin"), className: "bg-purple-500/15 text-purple-400" },
    PENDING: { label: t("rolePending"), className: "bg-yellow-500/15 text-yellow-400" },
  }[user.role] || { label: user.role, className: "bg-surface text-muted" };

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-theme">{t("accountTitle")}</h1>
      </div>

      {/* Underline tab bar */}
      <div className="mb-6 flex flex-wrap gap-x-5 gap-y-1 border-b border-border">
        {[
          { key: "info", label: t("accountInfo") },
          { key: "change", label: t("changeAccount") },
          { key: "appearance", label: t("appearance") },
          { key: "language", label: t("language") },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            aria-pressed={activeTab === tab.key}
            className={`-mb-px border-b-2 px-1 py-2.5 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "border-primary text-primary"
                : "border-transparent text-muted hover:text-theme"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="space-y-6">
        {/* Account info */}
        {activeTab === "info" && (
          <div className="rounded-xl border border-border bg-surface p-6 space-y-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">{t("roleLabel")}</span>
              <span
                className={`rounded-full px-3 py-0.5 text-xs font-semibold ${roleBadge.className}`}
              >
                {roleBadge.label}
              </span>
            </div>

            <div className="flex items-center justify-between border-t border-border pt-4">
              <span className="text-sm text-muted">{t("accountStatus")}</span>
              <span
                className={`rounded-full px-3 py-0.5 text-xs font-semibold ${
                  expired ? "bg-red-500/15 text-red-400" : "bg-green-500/15 text-green-400"
                }`}
              >
                {expired ? t("statusExpired") : t("statusActive")}
              </span>
            </div>

            <div className="flex items-center justify-between border-t border-border pt-4">
              <span className="text-sm text-muted">{t("expiresLabel")}</span>
              <span className="text-sm text-theme">
                {user.expiresAt
                  ? `${new Date(user.expiresAt).toLocaleDateString()}${daysInfo ? ` · ${daysInfo}` : ""}`
                  /* Guests are told "no time limit yet" rather than "never
                     expires" — a trial period is planned, and promising the
                     opposite now would read as a broken promise later. */
                  : isGuest ? t("guestNoExpiry") : t("noExpiry")}
              </span>
            </div>

            {user.monthlyFee != null && (
              <div className="flex items-center justify-between border-t border-border pt-4">
                <span className="text-sm text-muted">{t("monthlyFeeLabel")}</span>
                <span className="text-sm text-theme">
                  ¥{Number(user.monthlyFee).toFixed(2)} {t("perMonth")}
                </span>
              </div>
            )}

            {/* Guests get the full picture: what they have, what they do not,
                and how to lift the limits. */}
            {isGuest && (
              <>
                <div className="border-t border-border pt-4">
                  <p className="mb-3 text-sm font-semibold text-theme">
                    {t("yourPermissions")}
                  </p>
                  <ul className="space-y-2">
                    <PermissionRow
                      allowed
                      label={t("permCreatePlaylists")}
                      note={
                        ownedCount == null
                          ? null
                          : t("playlistUsage")
                              .replace("{used}", ownedCount)
                              .replace("{max}", GUEST_PLAYLIST_LIMIT)
                      }
                    />
                    <PermissionRow allowed label={t("permShareForLikes")} />
                    <PermissionRow label={t("permPublicPlaylist")} note={t("memberOnly")} />
                    <PermissionRow label={t("permAllowCopy")} note={t("memberOnly")} />
                  </ul>
                </div>

                <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
                  <p className="text-sm font-semibold text-theme">
                    {t("upgradePromptTitle")}
                  </p>
                  <p className="mt-1 text-xs text-muted">{t("upgradePromptBody")}</p>
                  <ContactAdmins />
                </div>
              </>
            )}

            {expired && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {t("renewalNotice")}
              </div>
            )}

            {/* Signing out sits at the foot of the account details rather than
                behind a tab of its own — a tab that held one button. */}
            <div className="border-t border-border pt-4">
              <button
                onClick={handleLogout}
                className="w-full rounded-lg border border-red-500/30 px-4 py-2.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
              >
                {t("logout")}
              </button>
            </div>
          </div>
        )}

        {/* Change account (username + password) */}
        {activeTab === "change" && (
          <>
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
          </>
        )}

        {/* Appearance */}
        {activeTab === "appearance" && (
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
        )}

        {/* Language */}
        {activeTab === "language" && (
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
        )}

      </div>
    </div>
  );
}
