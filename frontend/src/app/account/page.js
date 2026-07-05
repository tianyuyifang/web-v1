"use client";

import { useMemo } from "react";
import useAuth from "@/hooks/useAuth";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function AccountPage() {
  const { user, loading } = useAuth();
  const { t } = useLanguage();

  const daysInfo = useMemo(() => {
    if (!user?.expiresAt) return null;
    const ms = new Date(user.expiresAt).getTime() - Date.now();
    const days = Math.round(Math.abs(ms) / (24 * 60 * 60 * 1000));
    return ms >= 0
      ? t("daysLeft").replace("{n}", days)
      : t("expiredAgo").replace("{n}", days);
  }, [user, t]);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!user) return null;

  const expired = user.status === "expired";

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-theme">{t("accountTitle")}</h1>
      </div>

      <div className="rounded-xl border border-border bg-surface p-6 space-y-5">
        <div className="flex items-center justify-between">
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
              : t("noExpiry")}
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

        {expired && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {t("renewalNotice")}
          </div>
        )}
      </div>
    </div>
  );
}
