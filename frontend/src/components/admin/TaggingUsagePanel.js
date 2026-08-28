"use client";

import { useState, useEffect, useCallback } from "react";
import { adminAPI } from "@/lib/api";

/**
 * Who has been tagging songs into playlists.
 *
 * Counted from likes, not from capture events, because capture events only
 * exist for people who ran 自动打标. Measured over ten days, six of the fourteen
 * people tagging songs had never started it once — they listen and tag by hand
 * — so a capture-based count would have shown less than half of them.
 *
 * A like is written identically whether a person pressed it or 自动打标 did, so
 * one count covers both. The 自动打标 column then says which of the two this
 * person actually uses.
 *
 * Read-only and computed on request: nothing is stored or scheduled, so opening
 * the tab is what refreshes it.
 */

/**
 * Relative time, computed from two absolute instants so it needs no timezone.
 * The server runs on UTC and sends ISO timestamps; a server-formatted time
 * would read 05:31 for something that happened at 13:31 where the admin sits.
 */
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/** Zero is common in the split columns, and a row of 0s is just noise. */
function Count({ n, className = "" }) {
  return n > 0
    ? <span className={className}>{n}</span>
    : <span className="text-muted/40">—</span>;
}

export default function TaggingUsagePanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    adminAPI.getTaggingUsage()
      .then((res) => { setData(res.data); setError(""); })
      .catch((err) => setError(err.response?.data?.error?.message || "读取失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
          歌P使用情况
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
        <p className="text-sm text-muted">过去 10 天没有人打标。</p>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted">
            过去 10 天有 {data.users.length} 人打标，手动和自动都算在内，按最近一次排序。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="pb-2 pr-4 font-medium">用户</th>
                  <th className="pb-2 pr-4 text-right font-medium">最近一次打标</th>
                  <th className="pb-2 pr-4 text-right font-medium">总打标</th>
                  <th className="pb-2 pr-3 text-right font-medium">自己歌单</th>
                  <th className="pb-2 pr-3 text-right font-medium">他人歌单</th>
                  <th className="pb-2 text-right font-medium">自动打标</th>
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
                    <td className="py-2 pr-4 text-right tabular-nums" style={{ color: "var(--text)" }}>
                      {u.total}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted">
                      <Count n={u.ownCount} className="text-muted" />
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      <Count n={u.sharedCount} className="text-sky-400" />
                    </td>
                    {/* Not a setting anyone turned on — it says whether this
                        person has run 自动打标 at all. Someone tagging a lot by
                        hand may simply not know it exists. */}
                    <td className="py-2 text-right">
                      {u.usedCapture ? (
                        <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-[0.62rem] leading-tight text-green-400">
                          用
                        </span>
                      ) : (
                        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[0.62rem] leading-tight text-muted">
                          未用
                        </span>
                      )}
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
