"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import LoginForm from "@/components/auth/LoginForm";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { useTheme } from "@/components/layout/ThemeProvider";
import useAuth from "@/hooks/useAuth";
import { getToken, setToken } from "@/lib/auth";

// Arrived signed in: go straight in rather than asking for the password again.
// Plenty of people open the site from a bookmark of this page, and every such
// visit used to end in a re-login. Every route that sends someone here for a
// reason (session replaced, lapsed, pending, logged out) clears the token
// first, so none of them is skipped by this.
const FORWARD_AT_KEY = "login-forward-at";
const FORWARD_LOOP_MS = 10000; // back here this soon after forwarding: stop, show the form
const CHECK_TIMEOUT_MS = 4000; // the /me check taking longer than this: show the form

export default function LoginPage() {
  const { t } = useLanguage();
  const { theme } = useTheme();
  const searchParams = useSearchParams();
  const reason = searchParams.get("reason");
  const { user, loading } = useAuth();

  // "init" until mounted (localStorage is unknown before), "checking" while the
  // Navbar's /me decides a token found on arrival, "form" otherwise. Only a
  // token present on arrival counts: a login made on this page redirects by
  // itself, and a form shown once is never pulled away mid-typing.
  const [phase, setPhase] = useState("init");

  useEffect(() => {
    if (!getToken()) { setPhase("form"); return undefined; }
    setPhase("checking");
    const id = setTimeout(() => setPhase((p) => (p === "checking" ? "form" : p)), CHECK_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (phase !== "checking" || loading) return;
    // No verdict from the server (network) or not approved: the form, as before.
    if (!user || user.role === "PENDING") { setPhase("form"); return; }
    let lastForward = 0;
    try { lastForward = Number(sessionStorage.getItem(FORWARD_AT_KEY)) || 0; } catch { /* storage blocked */ }
    if (Date.now() - lastForward < FORWARD_LOOP_MS) { setPhase("form"); return; }
    // The page it forwards to is gated on the cookie, which iOS may have purged
    // while the token in localStorage lived on. Write it back — and forward
    // only if it took, or the gate would send this page straight back here.
    const token = getToken();
    if (!token) { setPhase("form"); return; }
    setToken(token);
    if (!document.cookie.split("; ").some((c) => c.startsWith("music_app_token="))) { setPhase("form"); return; }
    try { sessionStorage.setItem(FORWARD_AT_KEY, String(Date.now())); } catch { /* storage blocked */ }
    // A full load, as LoginForm does after a login, not router.replace: the
    // Navbar's links prefetch /playlists as this page mounts, and a prefetch
    // made before the cookie was written back holds the gate's redirect here —
    // router.replace would replay it (seen in about half of test runs).
    window.location.replace("/playlists");
  }, [phase, loading, user]);

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <img
            src={theme === "dark" ? "/brand_icon_dark.png" : "/brand_icon_light.png"}
            alt="logo"
            className="mb-4 h-14 w-14 rounded-2xl object-cover"
          />
          <img src={theme === "dark" ? "/qni_yixia_dark.png" : "/qni_yixia_light.png"} alt="Q你一下" className="h-7 object-contain" />
        </div>

        {reason === "session_replaced" && (
          <div className="mb-4 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-center text-sm text-theme">
            {t("sessionReplacedMessage")}
          </div>
        )}

        {/* Bounced here mid-session. Explain it up front rather than showing a
            blank form they will try to log into and be refused again.
            account_disabled = a lapsed member (续费); pending_approval = a
            never-approved signup (等待审核). */}
        {reason === "account_disabled" && (
          <div className="mb-4 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-center text-sm text-theme">
            {t("accountDisabledMessage")}
          </div>
        )}

        {reason === "pending_approval" && (
          <div className="mb-4 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-center text-sm text-theme">
            {t("pendingApprovalMessage")}
          </div>
        )}

        {phase === "checking" ? (
          <div className="flex justify-center py-10">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-surface p-6 shadow-lg shadow-black/5">
            <LoginForm />
          </div>
        )}
      </div>
    </div>
  );
}
