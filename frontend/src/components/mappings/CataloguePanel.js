"use client";

/**
 * 唱卡集 — 浏览所有 QNI 游戏里出现过的歌词段落，与审核无关。
 *
 * 数据源是 capture_events（演唱阶段、有歌词的），按游戏原文去重，带对应的
 * 游戏歌名/歌手和出现次数，可按歌名/歌手搜。纯浏览：不能确认、不能改，
 * 就是一本「都唱过些什么」的册子。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { mappingAPI } from "@/lib/api";

const PAGE = 40;

export default function CataloguePanel() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [nextOffset, setNextOffset] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  // 删除坏数据(OCR 读错的)。两步确认:点一次亮「确认删除」,再点才删。
  const [confirmDelId, setConfirmDelId] = useState(null);
  const [busyDelId, setBusyDelId] = useState(null);
  const runRef = useRef(0);

  const remove = useCallback(async (id) => {
    setBusyDelId(id);
    setError("");
    try {
      await mappingAPI.deleteCatalogueEntry(id);
      setRows((prev) => prev.filter((r) => r.id !== id));
      setConfirmDelId(null);
    } catch (err) {
      setError(err.response?.data?.error?.message || "删除失败");
    } finally {
      setBusyDelId(null);
    }
  }, []);

  const load = useCallback(async (query, offset = 0) => {
    const run = ++runRef.current;
    setLoading(true);
    setError("");
    try {
      const res = await mappingAPI.passageCatalogue({ q: query, offset, take: PAGE });
      if (run !== runRef.current) return;
      setRows((prev) => (offset ? [...prev, ...res.data.items] : res.data.items));
      setNextOffset(res.data.nextOffset);
    } catch (err) {
      if (run !== runRef.current) return;
      setError(err.response?.data?.error?.message || "读取失败");
    } finally {
      if (run === runRef.current) setLoading(false);
    }
  }, []);

  // Debounced on the query.
  useEffect(() => {
    const t = setTimeout(() => load(q.trim(), 0), q.trim() ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        所有在 QNI 里出现过的歌词段落，按游戏原文去重。可按歌名或歌手搜索；
        OCR 读错的坏数据可以「删除」（只删这条统计记录，不影响游戏流水）。
      </p>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="按歌名或歌手搜索…"
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800"
      />

      {error && <div className="text-sm text-red-500">{error}</div>}

      {loading && !rows.length ? (
        <p className="text-sm text-gray-500">加载中…</p>
      ) : !rows.length ? (
        <p className="text-sm text-gray-500">
          {q.trim() ? "没有匹配的段落。" : "还没有任何段落记录。"}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, i) => {
            // Prefer the real DB id (unique, stable across pages); fall back to
            // rawText#i only if a row somehow lacks one.
            const id = row.id || `${row.rawText}#${i}`;
            const open = openId === id;
            return (
              <li
                key={id}
                className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : id)}
                    className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-800 dark:text-gray-100">
                        {row.gameTitle || "（未知）"}
                        {row.gameArtist ? <span className="text-gray-500"> — {row.gameArtist}</span> : null}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-gray-500">
                        {row.gameLines.join(" / ")}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-gray-400">
                      出现 {row.seen} 次
                    </span>
                  </button>
                  {/* 删除坏数据。仅在有真实 id 时可删(兜底 id 无法定位后端行)。 */}
                  {row.id && (
                    confirmDelId === row.id ? (
                      <span className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          disabled={busyDelId === row.id}
                          onClick={() => remove(row.id)}
                          className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {busyDelId === row.id ? "删除中…" : "确认删除"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelId(null)}
                          className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelId(row.id)}
                        className="shrink-0 rounded border border-red-300 px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950"
                      >
                        删除
                      </button>
                    )
                  )}
                </div>
                {open && (
                  <div className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700">
                    <ol className="list-decimal space-y-0.5 pl-5 text-sm text-gray-700 dark:text-gray-300">
                      {row.gameLines.map((line, j) => <li key={j}>{line}</li>)}
                    </ol>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {nextOffset != null && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => load(q.trim(), nextOffset)}
            className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {loading ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </div>
  );
}
