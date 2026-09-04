"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { captureAPI } from "@/lib/api";
import { PRESET_COLORS } from "../player/ColorTag";
import SongPrefEditor, { SongPrefMarks } from "./SongPrefTags";

/**
 * The 已标记 tab: the songs this singer put a note or a colour on. A place to
 * find what they marked — and, since a mark is only ever a first guess, to
 * change it here too: open a row and the same editor the 标记 library and the
 * live card use edits the note and the colours in place.
 *
 * Notes and colours only, all the way through: what shows here, what the
 * filters offer, what a row displays and edits. Key and tempo are held on the
 * same record but never surface — they are a playback convenience, not a mark
 * made to find the song again, and showing them would blur what this tab is for.
 *
 * Unlike the library, an empty search box shows everything: the point is to
 * survey your own marks, and there are few enough of them that listing all is
 * the answer, not a refusal.
 *
 * An edit that takes a row out of the current filter (clearing the last note
 * while 有备注 is on) leaves it on screen rather than vanishing mid-edit —
 * a row disappearing under your own hands reads as a bug. It settles into its
 * new place on the next load, when the filter is re-applied.
 */

const PAGE = 40;

const SOURCE_LABEL = { LOCAL: "独家", QQ: "QQ", NETEASE: "网易" };

function formatDuration(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * The review page's two-line pairing, the same one the 标记 library shows: the
 * platform track on top because that is what plays, the game song beneath it in
 * muted text. Tapping opens the shared editor to change the note and colours;
 * no 未标记 badge, since every row here is marked by definition.
 */
function MarkedRow({ row, expanded, onToggle, onSave }) {
  return (
    <div
      className={`rounded-lg border bg-surface transition-colors ${
        expanded ? "border-accent" : "border-border"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5 overflow-hidden whitespace-nowrap text-[0.82rem] leading-tight">
            <span className="shrink-0 rounded bg-black/20 px-1 py-px text-[0.62rem] text-muted">
              {SOURCE_LABEL[row.source] || row.source}
            </span>
            <span className="truncate font-medium">
              {row.platformTitle || row.title || "—"}
              <span className="text-muted"> — {row.platformArtist || "—"}</span>
            </span>
            <span className="shrink-0 text-[0.68rem] tabular-nums text-muted">
              {formatDuration(row.durationSec)}
            </span>
          </span>

          <span className="mt-px flex items-baseline gap-1.5 overflow-hidden whitespace-nowrap text-[0.68rem] leading-tight text-muted">
            <span className="shrink-0 rounded bg-black/20 px-1 py-px text-[0.6rem]">QNI</span>
            <span className="truncate">
              {String(row.title || "").replace(/^《|》$/g, "") || "（歌曲已下架）"}
              {row.artist ? ` — ${row.artist}` : ""}
            </span>
          </span>

          {/* On a phone the marks drop to their own line under the two title
              rows, the same fix the live card uses: inline, a long note and the
              title fought over a narrow row. Desktop keeps them inline on the
              right (below), where there is room. */}
          <span className="mt-1 flex items-center gap-1.5 sm:hidden">
            <SongPrefMarks prefs={row.prefs} />
          </span>
        </span>

        {/* The note and colours, borrowed from the live card so the two tabs
            show a marked song the same way: note in muted text, colours after
            it. Desktop only — the phone shows them on their own line above. */}
        <span className="hidden shrink-0 items-center gap-2 sm:flex">
          <SongPrefMarks prefs={row.prefs} />
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-border/60 px-2.5 py-2">
          <SongPrefEditor prefs={row.prefs} onChange={(patch) => onSave(row, patch)} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * 好友视图复用同一个组件: 传 friendId 就只读地看那位好友的标记 ——
 * 取数换到分享门后的接口, 行不可展开(编辑器是改自己的备注用的,
 * 改别人的不存在这个操作)。其余一切 —— 搜索、过滤、分页、行的
 * 长相 —— 和本人的已标记完全同款, 好友看到的就是你看到的。
 */
export default function MarkedSongs({ friendId = null }) {
  const readOnly = Boolean(friendId);
  const [q, setQ] = useState("");
  const [hasNote, setHasNote] = useState(false);
  const [colors, setColors] = useState([]);   // selected hex filters
  const [rows, setRows] = useState([]);
  const [nextOffset, setNextOffset] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  // 只读视图永不展开行 —— openId 保持 null。

  // Drop out-of-order replies: changing a filter or typing fires overlapping
  // requests, and a slow early one landing last would show the wrong list.
  const runRef = useRef(0);

  const load = useCallback(async (params, offset = 0) => {
    const run = ++runRef.current;
    setLoading(true);
    setError("");
    try {
      const res = friendId
        ? await captureAPI.friendMarked(friendId, { ...params, offset, take: PAGE })
        : await captureAPI.marked({ ...params, offset, take: PAGE });
      if (run !== runRef.current) return;
      setRows((prev) => (offset ? [...prev, ...res.data.rows] : res.data.rows));
      setNextOffset(res.data.nextOffset);
    } catch (err) {
      if (run !== runRef.current) return;
      setError(err.response?.data?.error?.message || "读取失败");
    } finally {
      if (run === runRef.current) setLoading(false);
    }
  }, [friendId]);

  // Debounced on the query, immediate on the toggles: a keyword is typed a
  // character at a time and wants the 300ms wait, but clicking a colour is one
  // deliberate act that should answer at once.
  useEffect(() => {
    const params = { q: q.trim(), hasNote, colors };
    const t = setTimeout(() => load(params, 0), q.trim() ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, hasNote, colors, load]);

  const toggleColor = (c) =>
    setColors((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  /**
   * Save one field and keep the row in step — the same optimistic write the
   * 标记 library uses. The value is on screen before the request returns,
   * because these are single clicks and watching a colour appear a round trip
   * later feels broken; a failure puts the old value back and says so. The
   * row keeps its place even if the change would drop it from the current
   * filter, and re-sorts on the next load.
   */
  const save = useCallback((row, patch) => {
    const key = `${row.source}:${row.externalId}`;
    const before = row.prefs;
    const next = { ...(before || {}), ...patch };
    setRows((prev) => prev.map((r) =>
      `${r.source}:${r.externalId}` === key ? { ...r, prefs: next } : r));
    captureAPI
      .saveSongPref(row.source, row.externalId, patch)
      .catch(() => {
        setRows((prev) => prev.map((r) =>
          `${r.source}:${r.externalId}` === key ? { ...r, prefs: before } : r));
        setError("保存失败，请重试");
      });
  }, []);

  const anyFilter = hasNote || colors.length > 0 || q.trim();

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索歌名或歌手"
        className="mb-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
      />

      {/* Filters stack: 有备注 and any colours narrow to their intersection. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setHasNote((v) => !v)}
          className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
            hasNote ? "bg-yellow-500/20 text-yellow-400" : "bg-background text-muted hover:text-theme"
          }`}
        >
          有备注
        </button>
        <span className="mx-0.5 h-4 w-px bg-border" />
        {PRESET_COLORS.map((c) => {
          const on = colors.includes(c);
          return (
            <button
              key={c}
              type="button"
              onClick={() => toggleColor(c)}
              title="按此颜色筛选"
              className={`flex h-6 w-6 items-center justify-center rounded-full transition-transform ${
                on ? "scale-110 ring-2 ring-white/70" : "ring-1 ring-white/20 hover:scale-105"
              }`}
              style={{ background: c }}
            >
              {on ? <span className="text-[0.7rem] text-white drop-shadow">✓</span> : null}
            </button>
          );
        })}
        {anyFilter ? (
          <button
            type="button"
            onClick={() => { setQ(""); setHasNote(false); setColors([]); }}
            className="ml-1 rounded-full px-2 py-1 text-xs text-muted hover:text-theme"
          >
            清除
          </button>
        ) : null}
      </div>

      {error ? <p className="mb-2 text-xs text-red-400">{error}</p> : null}

      {!loading && !rows.length ? (
        <div className="rounded-xl border border-border bg-surface p-6 text-sm text-muted">
          {anyFilter
            ? "没有符合条件的标记。"
            : "还没有标记过的歌曲。在唱卡识别时或「标记」里给歌曲加备注、颜色后，就会出现在这里。"}
        </div>
      ) : null}

      <div className="space-y-1">
        {rows.map((row) => {
          const key = `${row.source}:${row.externalId}`;
          return (
            <MarkedRow
              key={key}
              row={row}
              expanded={openId === key}
              onToggle={readOnly ? undefined : () => setOpenId((cur) => (cur === key ? null : key))}
              onSave={save}
            />
          );
        })}
      </div>

      {loading ? (
        <div className="flex justify-center py-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : nextOffset != null ? (
        <button
          type="button"
          onClick={() => load({ q: q.trim(), hasNote, colors }, nextOffset)}
          className="mt-2 w-full rounded-lg border border-border bg-surface py-2 text-xs text-muted hover:text-theme"
        >
          加载更多
        </button>
      ) : null}
    </div>
  );
}
