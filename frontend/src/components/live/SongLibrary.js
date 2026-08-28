"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { captureAPI } from "@/lib/api";
import SongPrefEditor from "./SongPrefTags";

/**
 * Marking songs without waiting to meet them.
 *
 * Until now a colour or a note could only be set while a card was on screen,
 * which put the decision at the worst possible moment: the song has started,
 * everyone is waiting, and the thought "this one needs a note" is exactly the
 * thought there is no time to act on. It got forgotten, round after round, for
 * the same song.
 *
 * So this is the same marks, reachable between games. What it deliberately is
 * NOT is a player: there is no listening here. Resolving audio is the one part
 * of this feature that spends a credential and goes out over the server's
 * shared address, and browsing is a far faster activity than singing -- a
 * minute of scrolling would outspend a whole game. Every field below is one
 * already in our own database, so however long someone browses, nothing
 * leaves.
 *
 * Colour and note only, for the same reason. Key and tempo are settled by ear
 * against the song, and there is nothing to hear here; a number picked blind
 * would be a guess written down as a decision. Both still work on the card,
 * and anything already stored is left untouched -- this screen simply does not
 * show them.
 */

const PAGE = 40;

/**
 * What to call each source in front of a singer.
 *
 * The same three labels the cards and the review page use. Repeated rather
 * than imported because the live page holds its copy as a module constant, and
 * reaching into a page from a component would tie this file to that one's
 * shape; three short strings are the cheaper duplication.
 */
const SOURCE_LABEL = { LOCAL: "独家", QQ: "QQ", NETEASE: "网易" };

/**
 * Every row's fill, a step away from the page behind it.
 *
 * Every row, like the review page's list: each song is its own card, and the
 * open one is marked by an accent border rather than by being the only thing
 * with a background.
 *
 * Not `surface`, which is what that page uses. In the light and sepia themes
 * `surface` is *lighter* than the
 * background (#ffffff on #f0f0f5), so a surface card on this page measured a
 * 1.14 contrast ratio -- visible in theory, invisible in practice, which is
 * what "白色的，不明显" was describing.
 *
 * The obvious fixes both failed when measured. `surface-hover` goes the wrong
 * way in light themes (1.14 -> 1.07, since a light surface hovers lighter),
 * and mixing in the accent does the same (1.14 -> 1.02). Both assume dark, and
 * this app has four themes, two of each kind.
 *
 * Mixing the TEXT colour into the BACKGROUND works in all four, because text
 * is by definition the background's opposite: the card moves away from the
 * page whichever direction "away" happens to be. Measured: dark 1.36, light
 * 1.27, midnight 1.31, sepia 1.25 -- every one better than the 1.09-1.15 a
 * plain surface gave.
 */
const CARD_FILL = "[background-color:color-mix(in_srgb,var(--text)_12%,var(--background))]";
/** The same idea for the edge, further along so it reads as a boundary. */
const CARD_EDGE = "[border-color:color-mix(in_srgb,var(--text)_28%,var(--background))]";

function formatDuration(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function Row({ row, onSave, expanded, onToggle }) {
  const prefs = row.prefs;
  const colors = (prefs?.colorTag || "").split("|").filter(Boolean);
  // A song counts as marked on the two things this screen can set. Key and
  // tempo are deliberately not counted: they are set elsewhere, and a row
  // showing 标记过 for something invisible here would be unexplainable.
  const marked = Boolean(prefs?.note) || colors.length > 0;

  return (
    <div
      className={`rounded-lg border transition-colors ${CARD_FILL} ${
        expanded ? "border-accent" : CARD_EDGE
      }`}
    >
      {/* The review page's two-line pairing, borrowed wholesale: the platform
          track on top because that is what actually plays, the game song
          underneath in muted text. Both sides always shown, each behind its own
          chip, so the chip labels the line it sits on rather than appearing to
          label the text beside it. */}
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
              {row.platformTitle || row.title}
              <span className="text-muted"> — {row.platformArtist || "—"}</span>
            </span>
            <span className="shrink-0 text-[0.68rem] tabular-nums text-muted">
              {formatDuration(row.durationSec)}
            </span>
          </span>

          <span className="mt-px flex items-baseline gap-1.5 overflow-hidden whitespace-nowrap text-[0.68rem] leading-tight text-muted">
            <span className="shrink-0 rounded bg-black/20 px-1 py-px text-[0.6rem]">QNI</span>
            {/* 《》 is how 歌 P writes a title and never how 唱卡 does, so a row
                still carrying them came in through the wrong channel. Stripped
                for reading; the stored key is untouched. */}
            <span className="truncate">
              {String(row.title || "").replace(/^《|》$/g, "")}
              {row.artist ? ` — ${row.artist}` : ""}
            </span>
            {/* The note reads on the closed row, the way the review page shows
                its own: the whole point of writing one is seeing it later
                without opening anything. */}
            {prefs?.note ? (
              <span className="truncate text-yellow-500/80" title={prefs.note}>
                · {prefs.note}
              </span>
            ) : null}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2">
          {colors.map((c) => (
            <span
              key={c}
              className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/25"
              style={{ background: c }}
            />
          ))}
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] leading-tight ${
              marked
                ? "bg-green-500/15 text-green-400"
                : "bg-red-500/15 text-red-400"
            }`}
          >
            {marked ? "标记过" : "未标记"}
          </span>
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-border/60 px-2.5 py-2">
          <SongPrefEditor prefs={prefs} onChange={onSave} />
        </div>
      ) : null}
    </div>
  );
}

export default function SongLibrary() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [searched, setSearched] = useState(false);

  // Every fetch is stamped and a reply dropped unless it is the newest.
  // Typing produces overlapping requests that do not come back in order, so
  // without this a slow early reply lands after a fast later one and the list
  // ends up showing results for a prefix of what is in the box.
  const runRef = useRef(0);

  const load = useCallback(async (query, after = null) => {
    const run = ++runRef.current;
    setLoading(true);
    setError("");
    try {
      const res = await captureAPI.library({ q: query, cursor: after, take: PAGE });
      if (run !== runRef.current) return;
      setRows((prev) => (after ? [...prev, ...res.data.rows] : res.data.rows));
      setCursor(res.data.nextCursor);
      setSearched(true);
    } catch (err) {
      if (run !== runRef.current) return;
      setError(err.response?.data?.error?.message || "搜索失败");
    } finally {
      if (run === runRef.current) setLoading(false);
    }
  }, []);

  // Debounced: the query would otherwise run per keystroke. 300ms swallows a
  // burst of typing without feeling laggy.
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      runRef.current += 1;      // cancel anything in flight
      setRows([]); setCursor(null); setSearched(false); setLoading(false);
      return undefined;
    }
    const t = setTimeout(() => load(term), 300);
    return () => clearTimeout(t);
  }, [q, load]);

  /**
   * Save one field and keep the row in step.
   *
   * Optimistic: the value is on screen before the request returns, because
   * these are single clicks and waiting a round trip to watch a colour appear
   * feels broken. A failure puts the old value back and says so.
   */
  const save = useCallback((row, patch) => {
    const before = row.prefs;
    const next = { ...(before || {}), ...patch };
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, prefs: next } : r)));
    captureAPI
      .saveSongPref(row.source, row.externalId, patch)
      .catch(() => {
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, prefs: before } : r)));
        setError("保存失败，请重试");
      });
  }, []);

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索歌名或歌手"
        className="mb-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
      />

      {error ? <p className="mb-2 text-xs text-red-400">{error}</p> : null}

      {!searched && !loading ? (
        <div className="rounded-xl border border-border bg-surface p-6 text-sm text-muted">
          搜索歌名或歌手，给歌先加上颜色和备注。
        </div>
      ) : null}

      {searched && !rows.length && !loading ? (
        <div className="rounded-xl border border-border bg-surface p-6 text-sm text-muted">
          没有匹配的结果。
        </div>
      ) : null}

      <div className="space-y-1">
        {rows.map((row) => (
          <Row
            key={row.id}
            row={row}
            expanded={openId === row.id}
            onToggle={() => setOpenId((id) => (id === row.id ? null : row.id))}
            onSave={(patch) => save(row, patch)}
          />
        ))}
      </div>

      {loading ? <p className="p-6 text-sm text-muted">加载中…</p> : null}

      {cursor && !loading ? (
        <button
          type="button"
          onClick={() => load(q.trim(), cursor)}
          className="mt-2 w-full rounded-lg border border-border py-1.5 text-xs text-muted hover:text-fg"
        >
          加载更多
        </button>
      ) : null}
    </div>
  );
}
