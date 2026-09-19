"use client";

import { useState } from "react";
import Link from "next/link";
import useAuth from "@/hooks/useAuth";
import ContactAdmins from "@/components/account/ContactAdmins";
import RedeemBox from "@/components/account/RedeemBox";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function LoginForm() {
  const { t } = useLanguage();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  // Set when the credentials were right but the account is PENDING. Which kind
  // decides the wording: "disabled" = a lapsed member (续费), "pending" = a
  // never-approved signup (等待审核). null = not blocked.
  const [blocked, setBlocked] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username || !password) {
      setError(t("usernamePasswordRequired"));
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const data = await login(username, password);
      // Fallback only: login now refuses a PENDING account below rather than
      // returning one here. If any path ever hands one back, treat a former
      // member (previousRole) as "disabled", else "pending".
      if (data.user?.role === "PENDING") {
        setBlocked(data.user?.previousRole ? "disabled" : "pending");
      } else {
        window.location.href = "/dashboard";
      }
    } catch (err) {
      // The password was right, the account is PENDING. Show the matching panel
      // (not a red "wrong password" error): ACCOUNT_DISABLED = lapsed member,
      // PENDING_APPROVAL = never-approved signup.
      const code = err.response?.data?.error?.code;
      if (code === "ACCOUNT_DISABLED") {
        setBlocked("disabled");
      } else if (code === "PENDING_APPROVAL") {
        setBlocked("pending");
      } else {
        setError(err.response?.data?.error?.message || err.response?.data?.message || t("loginFailed"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Credentials were right, but the account is PENDING. Replace the form with
  // an explanation — a one-line error under a still-fillable form reads as
  // "wrong password", which is the one thing it is not. A lapsed member sees
  // the renewal wording; a never-approved signup sees "awaiting review", since
  // they never had a membership to have expired.
  if (blocked) {
    const isPendingApproval = blocked === "pending";
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-5 py-5">
          <p className="text-base font-semibold" style={{ color: "var(--text)" }}>
            {t(isPendingApproval ? "pendingApprovalTitle" : "pendingMemberExpiredTitle")}
          </p>
          <p className="mt-2 text-sm text-muted">
            {t(isPendingApproval ? "pendingApprovalBody" : "pendingMemberExpiredBody")}
          </p>
          <ContactAdmins />
        </div>
        {/* Self-service renewal: the user has an activation code (bought from an
            admin) and redeems it here without needing to log in. On success they
            are told to log in — role and expiry are now restored. */}
        <RedeemBox
          username={username}
          onSuccess={() => { setBlocked(false); setPassword(""); setError(""); }}
        />
        <button
          onClick={() => { setBlocked(false); setPassword(""); }}
          className="w-full rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-muted transition-colors hover:bg-surface-hover"
        >
          {t("return")}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label htmlFor="login-username" className="mb-1.5 block text-sm font-medium text-muted">
          {t("username")}
        </label>
        <input
          id="login-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none"
          style={{ color: "var(--text)" }}
        />
      </div>

      <div>
        <label htmlFor="login-password" className="mb-1.5 block text-sm font-medium text-muted">
          {t("password")}
        </label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm focus:border-primary focus:outline-none"
          style={{ color: "var(--text)" }}
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-400" role="alert">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? t("signingIn") : t("signIn")}
      </button>

      <p className="text-center text-sm text-muted">
        {t("noAccount")}{" "}
        <Link href="/register" className="font-medium text-primary hover:underline">
          {t("createOne")}
        </Link>
      </p>
    </form>
  );
}
