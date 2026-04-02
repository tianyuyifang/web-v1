"use client";

import { useState, useEffect } from "react";
import { adminAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";

function formatBytes(bytesStr) {
  const bytes = Number(bytesStr);
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

export default function BandwidthPanel() {
  const { t } = useLanguage();
  const [stats, setStats] = useState(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    adminAPI.getBandwidth(days)
      .then((res) => setStats(res.data))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, [days]);

  const periods = [
    { value: 1, label: t("bandwidthDay1") },
    { value: 7, label: t("bandwidthDay7") },
    { value: 30, label: t("bandwidthDay30") },
    { value: 90, label: t("bandwidthDay90") },
  ];

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="inline-block h-2 w-2 rounded-full bg-cyan-400" />
          {t("bandwidthTitle")}
        </h2>
        <div className="flex gap-1">
          {periods.map((p) => (
            <button
              key={p.value}
              onClick={() => setDays(p.value)}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                days === p.value
                  ? "bg-primary text-white"
                  : "bg-background text-muted hover:text-theme"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : !stats || stats.users.length === 0 ? (
        <p className="text-sm text-muted">{t("bandwidthNoData")}</p>
      ) : (
        <>
          {stats.trackingSince && (
            <p className="mb-3 text-xs text-muted">
              {t("bandwidthTrackingSince")}: {new Date(stats.trackingSince).toLocaleDateString()}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="pb-2 pr-4 font-medium">{t("bandwidthUser")}</th>
                  <th className="pb-2 pr-4 font-medium text-right">{t("bandwidthTotal")}</th>
                  <th className="pb-2 font-medium text-right">{t("bandwidthAvgDay")}</th>
                </tr>
              </thead>
              <tbody>
                {stats.users.map((u) => {
                  const avgPerDay = Number(u.totalBytes) / days;
                  return (
                    <tr key={u.userId} className="border-b border-border/50">
                      <td className="py-2 pr-4 font-medium" style={{ color: "var(--text)" }}>{u.username}</td>
                      <td className="py-2 pr-4 text-right text-muted">{formatBytes(u.totalBytes)}</td>
                      <td className="py-2 text-right text-muted">{formatBytes(avgPerDay.toString())}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
