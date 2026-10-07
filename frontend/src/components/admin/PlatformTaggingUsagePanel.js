"use client";

import { useState, useEffect, useCallback } from "react";
import api from "@/lib/api";

/**
 * Who has been using QQ打标, and how much.
 *
 * Its own component rather than a mode of TaggingUsagePanel, and it calls the
 * API client directly rather than through adminAPI, so adding it changes
 * neither 歌P使用 nor the module every page loads.
 *
 * 总打标 counts as the QQ打标 panel's 已打标 does: songs liked, or already
 * liked when it got there. Read-only and computed on request.
 */

/** Relative time from two absolute instants, so the server's UTC never shows. */
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export default function PlatformTaggingUsagePanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api.get("/admin/platform-tagging-usage")
      .then((res) => { setData(res.data); setError(""); })
      .catch((err) => setError(err.response?.data?.error?.message || "读取失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="inline-block h-2 w-2 rounded-full bg-green-400" />
          QQ打标使用情况
        </h2>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="shrink-0 rounded-full bg-background px-2.5 py-0.5 text-xs font-medium text-muted transition-colors hover:text-theme disabled:opacity-40"
        >
          刷新
        </button>
      </div>

      {loading && !data ? (
        <div className="flex justify-center py-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : !data || data.users.length === 0 ? (
        <p className="text-sm text-muted">过去 {data?.days || 30} 天没有人用 QQ打标。</p>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted">
            过去 {data.days} 天有 {data.users.length} 人用 QQ打标，按最近一次排序。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="pb-2 pr-4 font-medium">用户</th>
                  <th className="pb-2 pr-4 text-right font-medium">最近一次打标</th>
                  <th className="pb-2 text-right font-medium">总打标</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.userId} className="border-b border-border/50">
                    <td className="py-2 pr-4 font-medium" style={{ color: "var(--text)" }}>
                      {u.username}
                    </td>
                    <td
                      className="py-2 pr-4 text-right text-muted"
                      title={new Date(u.lastTagAt).toLocaleString()}
                    >
                      {timeAgo(u.lastTagAt)}
                    </td>
                    <td className="py-2 text-right tabular-nums" style={{ color: "var(--text)" }}>
                      {u.total}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
