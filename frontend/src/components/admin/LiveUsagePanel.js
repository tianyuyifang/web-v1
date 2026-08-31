"use client";

import { useState, useEffect, useCallback } from "react";
import { adminAPI } from "@/lib/api";

/**
 * Who has been using 唱卡 this week.
 *
 * Nothing here is stored or scheduled: the numbers are computed from rows the
 * feature already writes while it runs, so opening this tab is what refreshes
 * them. A singer mid-game shows up the moment you look.
 *
 * Seven days, fixed. Capture events are pruned after thirty, so a longer
 * window would promise history the data cannot supply.
 */

/**
 * Relative time, because "2小时前" is the question being asked -- whether
 * someone is using this now, recently, or not really.
 *
 * Computed from two absolute instants, so it needs no timezone: the server
 * runs on UTC and sends ISO timestamps, and a preformatted server-side time
 * would read 05:31 for a capture that happened at 13:31 where the admin sits.
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

/** Zero is the common case in these columns, and a row of 0s is just noise. */
function Count({ n, className = "" }) {
  return n > 0
    ? <span className={className}>{n}</span>
    : <span className="text-muted/40">—</span>;
}

export default function LiveUsagePanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // The marks table gets its own state: switching sub-tabs must not blank the
  // usage numbers behind it, and each view refreshes independently.
  const [view, setView] = useState("usage");
  const [marks, setMarks] = useState(null);
  const [marksLoading, setMarksLoading] = useState(false);
  const [marksError, setMarksError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    adminAPI.getLiveUsage()
      .then((res) => { setData(res.data); setError(""); })
      .catch((err) => setError(err.response?.data?.error?.message || "读取失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const loadMarks = useCallback(() => {
    setMarksLoading(true);
    adminAPI.getLiveMarks()
      .then((res) => { setMarks(res.data); setMarksError(""); })
      .catch((err) => setMarksError(err.response?.data?.error?.message || "读取失败"))
      .finally(() => setMarksLoading(false));
  }, []);

  // Fetched when first looked at, not on mount: the usage view is what the
  // tab opens on, and the marks query should cost nothing until wanted.
  useEffect(() => {
    if (view === "marks" && !marks) loadMarks();
  }, [view, marks, loadMarks]);

  const subTab = (key, label) => (
    <button
      type="button"
      onClick={() => setView(key)}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        view === key
          ? "bg-background text-theme"
          : "text-muted hover:text-theme"
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="inline-block h-2 w-2 rounded-full bg-rose-400" />
          唱卡使用情况
        </h2>
        {/* The numbers move while a game is running, so re-reading them is a
            thing you actually want -- without this the only way is a full page
            reload, which also throws away whichever tab you were on. */}
        <button
          type="button"
          onClick={view === "usage" ? load : loadMarks}
          disabled={view === "usage" ? loading : marksLoading}
          className="shrink-0 rounded-full bg-background px-2.5 py-0.5 text-xs font-medium text-muted transition-colors hover:text-theme disabled:opacity-40"
        >
          刷新
        </button>
      </div>

      <div className="mb-4 flex items-center gap-1">
        {subTab("usage", "唱卡使用记录")}
        {subTab("marks", "唱卡标记统计")}
      </div>

      {view === "marks" ? (
        marksLoading && !marks ? (
          <div className="flex justify-center py-4">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : marksError ? (
          <p className="text-sm text-red-400">{marksError}</p>
        ) : !marks || marks.users.length === 0 ? (
          <p className="text-sm text-muted">还没有人保存过标记。</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted">
              全历史现存标记，共 {marks.users.length} 人
              · {marks.users.reduce((s, u) => s + u.total, 0)} 条，按总数排序。
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="pb-2 pr-4 font-medium">用户</th>
                    <th className="pb-2 pr-4 text-right font-medium">总数</th>
                    <th className="pb-2 pr-4 text-right font-medium">变速</th>
                    <th className="pb-2 pr-4 text-right font-medium">变调</th>
                    <th className="pb-2 pr-4 text-right font-medium">备注</th>
                    <th className="pb-2 text-right font-medium">标签</th>
                  </tr>
                </thead>
                <tbody>
                  {marks.users.map((u) => (
                    <tr key={u.username} className="border-b border-border/50">
                      <td className="py-2 pr-4 font-medium" style={{ color: "var(--text)" }}>
                        {u.username}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{u.total}</td>
                      <td className="py-2 pr-4 text-right tabular-nums"><Count n={u.speed} /></td>
                      <td className="py-2 pr-4 text-right tabular-nums"><Count n={u.pitch} /></td>
                      <td className="py-2 pr-4 text-right tabular-nums"><Count n={u.note} /></td>
                      <td className="py-2 text-right tabular-nums"><Count n={u.color} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : null}

      {view !== "usage" ? null : loading && !data ? (
        <div className="flex justify-center py-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : !data || data.users.length === 0 ? (
        <p className="text-sm text-muted">过去 7 天没有人使用唱卡。</p>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted">
            过去 7 天有 {data.users.length} 人使用，按最近一次识别排序。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="pb-2 pr-4 font-medium">用户</th>
                  <th className="pb-2 pr-4 text-right font-medium">最近一次识别</th>
                  <th className="pb-2 pr-4 text-right font-medium">7 天识别</th>
                  {/* The three 24-hour columns are grouped under one idea, so
                      the header says the window once rather than three times. */}
                  <th className="pb-2 pr-3 text-right font-medium">24 小时 · 已确认</th>
                  <th className="pb-2 pr-3 text-right font-medium">待确认</th>
                  <th className="pb-2 text-right font-medium">未配置</th>
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
                      title={new Date(u.lastCaptureAt).toLocaleString()}
                    >
                      {timeAgo(u.lastCaptureAt)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums text-muted">
                      {u.weekTotal}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      <Count n={u.hourConfirmed} className="text-green-400" />
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      <Count n={u.hourPending} className="text-yellow-500/90" />
                    </td>
                    {/* Worth its own colour: a number here means someone is
                        singing songs the library has no mapping for, which is
                        the signal that something needs adding. */}
                    <td className="py-2 text-right tabular-nums">
                      <Count n={u.hourUnmapped} className="text-red-400" />
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
