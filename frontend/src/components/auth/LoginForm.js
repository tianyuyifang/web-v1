"use client";

import { useState } from "react";
import Link from "next/link";
import useAuth from "@/hooks/useAuth";
import ContactAdmins from "@/components/account/ContactAdmins";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function LoginForm() {
  const { t } = useLanguage();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  // Set when the credentials were right but the account is disabled. Holds
  // what the user was before — GUEST, MEMBER, or NONE if never recorded.
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
      if (data.user?.role === "PENDING") {
        // Why the account is disabled decides what to say. An expired guest
        // needs to be sold a membership; a lapsed member just needs to renew.
        setBlocked(data.user.previousRole || "NONE");
      } else {
        window.location.href = "/dashboard";
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || err.response?.data?.message || t("loginFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  // Credentials were right, but the account is switched off. Replace the form
  // with an explanation — a one-line error under a still-fillable form reads
  // as "wrong password", which is the one thing it is not.
  if (blocked) {
    const copy = {
      GUEST: {
        title: t("pendingGuestExpiredTitle"),
        body: t("pendingGuestExpiredBody"),
      },
      MEMBER: {
        title: t("pendingMemberExpiredTitle"),
        body: t("pendingMemberExpiredBody"),
      },
    }[blocked] || {
      title: t("pendingDefaultTitle"),
      body: t("pendingDefaultBody"),
    };

    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-5 py-5">
          <p className="text-base font-semibold" style={{ color: "var(--text)" }}>
            {copy.title}
          </p>
          <p className="mt-2 text-sm text-muted">{copy.body}</p>
          <ContactAdmins />
        </div>
        <button
          onClick={() => { setBlocked(null); setPassword(""); }}
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
