"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { captureAPI } from "@/lib/api";
import SongPrefEditor from "./SongPrefTags";
import {
  PITCH_STEPS, SPEED_STEPS, sameValue, LADDER_BUTTON, LADDER_TINT,
} from "./ladderStyle";

/**
 * Marking songs without waiting to meet them.
 *
 * Until now a key or a colour could only be set while a card was on screen,
 * which put the decision at the worst possible moment: the song has started,
 * everyone is waiting, and the thought "this one is too high for me" is
 * exactly the thought there is no time to act on. It got forgotten, round
 * after round, for the same song.
 *
 * So this is the same marks, reachable between games. What it deliberately is
 * NOT is a player: there is no listening here. Resolving audio is the one part
 * of this feature that spends a credential and goes out over the server's
 * shared address, and browsing is a far faster activity than singing -- a
 * minute of scrolling would outspend a whole game. Every field below is one
 * already in our own database, so however long someone browses, nothing
 * leaves.
 */

const PAGE = 40;

/**
 * A ladder of keys or tempos.
 *
 * An unset song shows the value it will actually play at -- the singer's
 * global default -- rather than a blank, because a blank says nothing about
 * what happens when the song comes up, and adjusting from a real number is
 * easier than picking one from nothing. It is dimmed, so a glance still
 * separates songs that have been decided from songs merely following the
 * default.
 */
function Ladder({ steps, value, isSet, onPick, format }) {
  return (
    <div className="flex items-center gap-1">
      {steps.map((s) => {
        const on = sameValue(s, value);
        return (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className={`${LADDER_BUTTON} ${
              on
                ? `${LADDER_TINT} text-fg ${isSet ? "" : "opacity-45"}`
                : "text-muted hover:text-fg"
            }`}
          >
            {format(s)}
          </button>
        );
      })}
    </div>
  );
}

function Row({ row, defaults, onSave, expanded, onToggle }) {
  const prefs = row.prefs;
  // "Set" means this song has its own value, not that the value differs from
  // the default: choosing the default on purpose is a decision too, and the
  // row should stop looking undecided once it has been made.
  const pitchSet = typeof prefs?.pitch === "number";
  const speedSet = typeof prefs?.speed === "number";
  const pitch = pitchSet ? prefs.pitch : (defaults?.pitch ?? 0);
  const speed = speedSet ? prefs.speed : (defaults?.speed ?? 1);

  // Both sides of the name, because they disagree about a quarter of the time
  // and which one the singer remembers is not predictable. The second line is
  // dropped when it would only repeat the first, so the common case stays
  // quiet.
  const platformDiffers = row.platformTitle
    && (row.platformTitle !== row.title || row.platformArtist !== row.artist);

  const colors = (prefs?.colorTag || "").split("|").filter(Boolean);
  const marked = pitchSet || speedSet || prefs?.note || colors.length;

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-1 py-2 text-left hover:bg-white/[0.02]"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm">{row.title}</span>
            <span className="shrink-0 truncate text-xs text-muted">{row.artist}</span>
          </span>
          {platformDiffers ? (
            <span className="mt-0.5 block truncate text-[0.68rem] text-muted/70">
              {row.source} · {row.platformTitle}
              {row.platformArtist ? ` - ${row.platformArtist}` : ""}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {prefs?.note ? (
            <span className="max-w-[8rem] truncate text-[0.68rem] text-muted" title={prefs.note}>
              {prefs.note}
            </span>
          ) : null}
          {colors.map((c) => (
            <span
              key={c}
              className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/25"
              style={{ background: c }}
            />
          ))}
          {marked ? null : <span className="text-[0.68rem] text-muted/50">未设置</span>}
        </span>
      </button>

      {expanded ? (
        <div className="space-y-2 px-1 pb-3 pt-1">
          <div className="flex items-center gap-2">
            <span className="w-8 shrink-0 text-[0.68rem] text-muted">变调</span>
            <Ladder
              steps={PITCH_STEPS}
              value={pitch}
              isSet={pitchSet}
              onPick={(v) => onSave({ pitch: v })}
              format={(s) => (s > 0 ? `+${s}` : String(s))}
            />
            {pitchSet ? (
              <button
                type="button"
                onClick={() => onSave({ pitch: null })}
                className="text-[0.68rem] text-muted hover:text-fg"
              >
                清除
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <span className="w-8 shrink-0 text-[0.68rem] text-muted">变速</span>
            <Ladder
              steps={SPEED_STEPS}
              value={speed}
              isSet={speedSet}
              onPick={(v) => onSave({ speed: v })}
              format={(s) => (sameValue(s, 1) ? "1" : String(s))}
            />
            {speedSet ? (
              <button
                type="button"
                onClick={() => onSave({ speed: null })}
                className="text-[0.68rem] text-muted hover:text-fg"
              >
                清除
              </button>
            ) : null}
          </div>

          {/* The same editor the card uses, so a colour means one thing. */}
          <SongPrefEditor prefs={prefs} onChange={onSave} />
        </div>
      ) : null}
    </div>
  );
}

export default function SongLibrary({ defaults }) {
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
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

  const load = useCallback(async (query, onlyMine, after = null) => {
    const run = ++runRef.current;
    setLoading(true);
    setError("");
    try {
      const res = await captureAPI.library({
        q: query, mine: onlyMine, cursor: after, take: PAGE,
      });
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
    if (!term && !mine) {
      runRef.current += 1;      // cancel anything in flight
      setRows([]); setCursor(null); setSearched(false); setLoading(false);
      return undefined;
    }
    const t = setTimeout(() => load(term, mine), 300);
    return () => clearTimeout(t);
  }, [q, mine, load]);

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
      <div className="mb-3 flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索歌名或歌手"
          className="min-w-0 flex-1 rounded border border-border bg-surface px-3 py-1.5 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
        />
        <button
          type="button"
          onClick={() => setMine((v) => !v)}
          className={`shrink-0 rounded border px-2.5 py-1.5 text-xs transition-colors ${
            mine
              ? `border-accent ${LADDER_TINT} text-fg`
              : "border-border text-muted hover:text-fg"
          }`}
        >
          我标过的
        </button>
      </div>

      {error ? <p className="mb-2 text-xs text-red-400">{error}</p> : null}

      {!searched && !loading ? (
        <p className="py-8 text-center text-xs text-muted">
          搜索歌名或歌手，给歌先设好调、速度、颜色和备注。
        </p>
      ) : null}

      {searched && !rows.length && !loading ? (
        <p className="py-8 text-center text-xs text-muted">
          {mine ? "还没有标记过的歌。" : "没有找到已确认的歌。"}
        </p>
      ) : null}

      <div>
        {rows.map((row) => (
          <Row
            key={row.id}
            row={row}
            defaults={defaults}
            expanded={openId === row.id}
            onToggle={() => setOpenId((id) => (id === row.id ? null : row.id))}
            onSave={(patch) => save(row, patch)}
          />
        ))}
      </div>

      {loading ? <p className="py-3 text-center text-xs text-muted">加载中…</p> : null}

      {cursor && !loading ? (
        <button
          type="button"
          onClick={() => load(q.trim(), mine, cursor)}
          className="mt-2 w-full rounded border border-border py-1.5 text-xs text-muted hover:text-fg"
        >
          加载更多
        </button>
      ) : null}
    </div>
  );
}
