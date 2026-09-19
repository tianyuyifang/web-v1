"use client";

import { useState } from "react";
import { authAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";

/**
 * Redeem an activation code to renew an account.
 *
 * Public flow: takes a username + code and calls /auth/redeem (no login token
 * needed), so a lapsed/PENDING user can renew from the login screen. When a
 * username is passed in (the login screen already has it) that field is locked;
 * on the account page a logged-in member's username is passed the same way.
 *
 * The "buy a code" link uses t("redeemBuyUrl") — set that one i18n value to the
 * purchase page when it exists; while it's "#" the link is hidden.
 *
 * @param {object} props
 * @param {string} [props.username] - prefill/lock the username
 * @param {() => void} [props.onSuccess] - called after a successful redeem
 */
export default function RedeemBox({ username = "", onSuccess }) {
  const { t } = useLanguage();
  const [name, setName] = useState(username);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null); // { expiresAt } on success

  const buyUrl = t("redeemBuyUrl");
  const hasBuyUrl = buyUrl && buyUrl !== "#" && buyUrl !== "redeemBuyUrl";

  const submit = async (e) => {
    e.preventDefault();
    const u = (username || name).trim();
    const c = code.trim();
    if (!u || !c) { setError(t("redeemNeedBoth")); return; }
    setBusy(true);
    setError("");
    try {
      const res = await authAPI.redeem(u, c);
      setDone({ expiresAt: res.data.expiresAt });
      if (onSuccess) onSuccess(res.data);
    } catch (err) {
      setError(err.response?.data?.error?.message || t("redeemFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const until = done.expiresAt
      ? new Date(done.expiresAt).toLocaleDateString()
      : null;
    return (
      <div className="rounded-xl border border-green-500/20 bg-green-500/10 px-5 py-4">
        <p className="text-sm font-semibold text-green-400">{t("redeemSuccess")}</p>
        {until && <p className="mt-1 text-sm text-muted">{t("redeemNewExpiry").replace("{date}", until)}</p>}
        <p className="mt-1 text-sm text-muted">{t("redeemNowLogin")}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-border bg-surface px-5 py-4">
      <p className="mb-2 text-sm font-medium text-theme">{t("redeemTitle")}</p>
      {!username && (
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("username")}
          className="mb-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-theme"
        />
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("redeemPlaceholder")}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-theme"
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {busy ? "…" : t("redeemButton")}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {hasBuyUrl && (
        <a
          href={buyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
        >
          {t("redeemBuy")}
        </a>
      )}
    </form>
  );
}
