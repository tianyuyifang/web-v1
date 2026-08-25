"use client";

/**
 * 未配置 — songs the game has shown that nothing in the catalogue answers.
 *
 * The other three tabs look outward from the catalogue. This one looks the
 * other way, from the game inward, and it is the only view that can show a gap:
 * a song people are singing that we cannot play at all.
 *
 * Its own component rather than a fourth bucket in the page, because it shares
 * almost nothing with them — different unit (a game text, not a mapping row),
 * different actions, and a list that is recomputed rather than paged. Folding
 * it in would have meant threading four more pieces of state through the
 * existing rows for the sake of one tab.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { mappingAPI } from "@/lib/api";

const SOURCE_LABEL = { LOCAL: "曲库", QQ: "QQ", NETEASE: "网易" };

/**
 * The three things that can be wrong, and what each one needs.
 *
 * Kept apart because the actions differ: one is a button, one is a judgement,
 * one is a shopping list. Showing them in one undifferentiated list is what the
 * old "unmapped" outcome did, and it is why nobody could act on it.
 */
const STATES = {
  resolvable: {
    label: "可自动配",
    hint: "曲库里歌名和歌手都对得上，重新解析即可",
    className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  },
  "needs-choice": {
    label: "需人工选",
    hint: "曲库里有同名的歌，但歌手对不上或游戏没给歌手",
    className: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  absent: {
    label: "曲库没有",
    hint: "曲库里找不到这首歌，需要先导入",
    className: "bg-red-500/15 text-red-300 border-red-500/30",
  },
};

function formatDuration(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

function relativeDay(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return `${days} 天前`;
}

export default function UnconfiguredPanel({ onCountsChange }) {
  /**
   * The callback, held still.
   *
   * The parent passes an inline arrow, so it is a new function on every one of
   * its renders. Depending on it directly made `load` new every render, which
   * refired the effect, which reported a count, which re-rendered the parent —
   * a request every few hundred milliseconds for as long as the tab was open,
   * against the most expensive read on the page.
   */
  const notifyCounts = useRef(onCountsChange);
  useEffect(() => { notifyCounts.current = onCountsChange; }, [onCountsChange]);
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ total: 0 });
  const [truncated, setTruncated] = useState(false);
  // How many the server matched, when a search is narrowing the list. Null
  // when nothing is being searched, so the badge stands alone.
  const [matched, setMatched] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState("");

  // Which row has its search panel open, and what that search has found.
  const [openRow, setOpenRow] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // The artist editor, and the row that prefilled it.
  const [artistsOpen, setArtistsOpen] = useState(false);
  const [artists, setArtists] = useState({ manual: [], derived: [], total: 0 });
  const [artistName, setArtistName] = useState("");
  const [artistNote, setArtistNote] = useState("");
  const [artistError, setArtistError] = useState("");

  const load = useCallback(async (q = "") => {
    setLoading(true);
    setError("");
    try {
      const res = await mappingAPI.unconfigured(q);
      setRows(res.data.rows || []);
      setCounts(res.data.counts || { total: 0 });
      setTruncated(!!res.data.truncated);
      setMatched(res.data.query ? res.data.matched : null);
      notifyCounts.current?.(res.data.counts?.total ?? 0);
    } catch (err) {
      setError(err.response?.data?.error?.message || "读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadArtists = useCallback(async () => {
    try {
      const res = await mappingAPI.dashedArtists();
      setArtists(res.data || { manual: [], derived: [], total: 0 });
      setArtistError("");
    } catch (err) {
      // Said out loud rather than swallowed: an empty list looks identical to a
      // successful read of a genuinely empty table, and an admin would add a
      // name that is already there and be told it is a duplicate.
      setArtistError(err.response?.data?.error?.message || "歌手列表读取失败");
    }
  }, []);

  useEffect(() => { if (artistsOpen) loadArtists(); }, [artistsOpen, loadArtists]);

  /** Run the queue back through the resolver the game itself uses. */
  const reresolve = async () => {
    setBusy("reresolve");
    setNote("");
    setError("");
    try {
      const res = await mappingAPI.reresolve();
      const { configured, stillUnconfigured } = res.data;
      setNote(configured
        ? `配好了 ${configured} 首，还剩 ${stillUnconfigured} 首`
        : `没有可以自动配的，还剩 ${stillUnconfigured} 首`);
      // The list is rebuilt, so any open search panel belongs to a row that may
      // no longer exist or may have changed state; its results are stale either
      // way, and 就是这个 would bind against them.
      setOpenRow(null);
      await load(query);
    } catch (err) {
      setError(err.response?.data?.error?.message || "重新解析失败");
    } finally {
      // Only if still ours: this is the slowest action here, and the artist
      // editor's own finally would otherwise re-enable the button mid-flight.
      setBusy((p) => (p === "reresolve" ? null : p));
    }
  };


  const runSearch = async (term) => {
    const t = String(term || "").trim();
    if (!t) { setResults([]); return; }
    setSearching(true);
    try {
      const res = await mappingAPI.poolSearch(t);
      setResults(res.data.rows || []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  /** Open the search panel for one row, prefilled with its title. */
  const openSearch = async (row) => {
    if (openRow === row.rawText) { setOpenRow(null); return; }
    setOpenRow(row.rawText);
    setResults([]);
    setSearchTerm(row.title);
    // Search straight away: the title is what the admin would have typed, and
    // making them press a button first is a step for nothing.
    await runSearch(row.title);
  };

  /** Bind this game text to that pool track. */
  const configure = async (row, track) => {
    setBusy(`cfg:${row.rawText}`);
    setError("");
    try {
      await mappingAPI.configure({
        rawText: row.rawText,
        source: track.source,
        externalId: track.externalId,
      });
      setNote(`已配好「${row.title}」→ ${track.title} · ${track.artist}`);
      setOpenRow(null);
      await load(query);
    } catch (err) {
      setError(err.response?.data?.error?.message || "配置失败");
    } finally {
      setBusy((p) => (p === `cfg:${row.rawText}` ? null : p));
    }
  };

  /** Drop every capture of this text. */
  const forget = async (row) => {
    setBusy(`del:${row.rawText}`);
    setError("");
    try {
      await mappingAPI.forget(row.rawText);
      // Same reason as above: the row that owned the open panel may be the one
      // just removed.
      setOpenRow(null);
      await load(query);
    } catch (err) {
      setError(err.response?.data?.error?.message || "删除失败");
    } finally {
      setBusy((p) => (p === `del:${row.rawText}` ? null : p));
    }
  };

  /**
   * Guess the artist name a bad split mangled, and open the editor with it.
   *
   * When the split is wrong the artist half is the tail of a name — "K" out of
   * "IN-K" — so the whole name is that tail plus whatever the title wrongly
   * absorbed after its last dash. Right often enough to save the typing, and
   * the admin confirms it either way.
   */
  const addArtistFrom = (row) => {
    const lastDash = Math.max(row.title.lastIndexOf("-"), row.title.lastIndexOf("—"));
    // Trimmed, because a title like "雨蝶 - 电视剧主题曲" is spaced around its
    // dash and the untrimmed slice prefills a leading space the admin has to
    // delete. The guess is offered, never assumed — it is editable.
    const tail = lastDash >= 0 ? row.title.slice(lastDash + 1).trim() : "";
    const guess = tail && row.artist ? `${tail}-${row.artist}` : row.artist || "";
    setArtistName(guess);
    setArtistNote(`来自「${row.rawText}」`);
    setArtistError("");
    setArtistsOpen(true);
  };

  const addArtist = async () => {
    setArtistError("");
    setBusy("artist");
    try {
      await mappingAPI.addDashedArtist({ name: artistName, note: artistNote || undefined });
      setArtistName("");
      setArtistNote("");
      await loadArtists();
      setNote("歌手已添加，可以点「重新解析」看效果");
    } catch (err) {
      setArtistError(err.response?.data?.error?.message || "添加失败");
    } finally {
      setBusy((p) => (p === "artist" ? null : p));
    }
  };

  const removeArtist = async (id) => {
    setBusy(`art:${id}`);
    try {
      await mappingAPI.removeDashedArtist(id);
      await loadArtists();
    } catch (err) {
      setArtistError(err.response?.data?.error?.message || "删除失败");
    } finally {
      setBusy((p) => (p === `art:${id}` ? null : p));
    }
  };

  const shown = filter === "all" ? rows : rows.filter((r) => r.state === filter);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => { e.preventDefault(); load(query); }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索游戏里的歌名"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-fg">
            搜索
          </button>
        </form>
        <button
          type="button"
          onClick={reresolve}
          disabled={busy === "reresolve"}
          className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          title="用识别唱卡时的同一套规则，把能配的自动配掉"
        >
          {busy === "reresolve" ? "解析中…" : "重新解析"}
        </button>
        <button
          type="button"
          onClick={() => setArtistsOpen((v) => !v)}
          className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-fg"
        >
          歌手库 {artistsOpen ? "▴" : "▾"}
        </button>
      </div>

      {/* Said out loud when a search is on. The counts below are the whole
          queue, not the search result, so without this the badge reads 343
          above three rows and the reader has to work out why. */}
      {matched != null && (
        <p className="mb-2 text-xs text-muted">
          搜索到 {matched} 条（下面的数字是整个队列）
        </p>
      )}

      {/* Filter by what each row needs, since the action differs per state. */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {[["all", `全部 ${counts.total ?? 0}`], ...Object.entries(STATES).map(
          ([k, v]) => [k, `${v.label} ${counts[k] ?? 0}`]
        )].map(([k, label]) => (
          <button
            key={k}
            type="button"
            title={STATES[k]?.hint}
            onClick={() => setFilter(k)}
            className={`rounded-md border px-2.5 py-1 text-xs transition ${
              filter === k ? "border-accent bg-accent/10 text-accent" : "border-border text-muted hover:text-fg"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {artistsOpen && (
        <div className="mb-4 rounded-lg border border-border bg-surface p-3">
          <p className="mb-2 text-xs text-muted">
            名字里带横杠的歌手。切分「歌名-歌手」时靠它分辨这个横杠属于名字还是分隔符。
            <span className="ml-1 text-fg">只填一位歌手</span>
            ，合作分开添加 —— 一位就够覆盖他参与的所有组合。
          </p>
          <div className="mb-2 flex flex-wrap gap-2">
            <input
              value={artistName}
              onChange={(e) => setArtistName(e.target.value)}
              placeholder="例如 IN-K"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
            />
            <input
              value={artistNote}
              onChange={(e) => setArtistNote(e.target.value)}
              placeholder="备注（可选）"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={addArtist}
              disabled={busy === "artist" || !artistName.trim()}
              className="rounded-lg border border-accent px-3 py-1.5 text-sm text-accent disabled:opacity-40"
            >
              添加
            </button>
          </div>
          {artistError && <p className="mb-2 text-xs text-red-300">{artistError}</p>}

          {artists.manual.length > 0 && (
            <ul className="mb-2 space-y-1">
              {artists.manual.map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-fg">{a.name}</span>
                  {a.note && <span className="truncate text-muted">{a.note}</span>}
                  <button
                    type="button"
                    onClick={() => removeArtist(a.id)}
                    disabled={busy === `art:${a.id}`}
                    className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-[0.65rem] text-muted hover:border-red-500/50 hover:text-red-300 disabled:opacity-40"
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}

          <details className="text-xs text-muted">
            <summary className="cursor-pointer">曲库自动提供的 {artists.derived.length} 位（只读）</summary>
            <p className="mt-1 font-mono leading-relaxed">{artists.derived.join("  ·  ")}</p>
          </details>
        </div>
      )}

      {note && <p className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300">{note}</p>}
      {error && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">{error}</p>}

      {loading && <p className="py-8 text-center text-sm text-muted">读取中…</p>}

      {!loading && !shown.length && (
        <p className="py-8 text-center text-sm text-muted">
          {counts.total ? "这个筛选下没有记录。" : "没有未配置的歌 — 游戏里出现过的都能播。"}
        </p>
      )}

      <ul className="space-y-2">
        {shown.map((row) => {
          const state = STATES[row.state] || STATES.absent;
          const isOpen = openRow === row.rawText;
          // A split is suspect when the artist half is very short or the title
          // still carries a dash: both are what a mis-split leaves behind.
          const suspect = row.artist && row.artist.length <= 2
            && /[-–—]/.test(row.title);
          return (
            <li key={row.rawText} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-fg">{row.rawText}</p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    切分 → 歌名「{row.title}」
                    {row.artist ? ` 歌手「${row.artist}」` : " 歌手（游戏未给）"}
                    {suspect && <span className="ml-1 text-amber-300">⚠ 看起来切错了</span>}
                  </p>
                  <p className="mt-0.5 text-[0.7rem] text-muted">
                    出现 {row.seen} 次 · {relativeDay(row.lastSeen)}
                  </p>
                </div>
                <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[0.7rem] ${state.className}`} title={state.hint}>
                  {state.label}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => openSearch(row)}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-fg"
                >
                  {isOpen ? "收起" : "手动配"}
                </button>
                <button
                  type="button"
                  onClick={() => addArtistFrom(row)}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:border-accent hover:text-fg"
                  title="切分错了？把歌手名加进歌手库"
                >
                  加歌手
                </button>
                <button
                  type="button"
                  onClick={() => forget(row)}
                  disabled={busy === `del:${row.rawText}`}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:border-red-500/50 hover:text-red-300 disabled:opacity-40"
                  title="删除这首歌的所有抓取记录。下次再遇到会重新判断。"
                >
                  {busy === `del:${row.rawText}` ? "…" : "删除"}
                </button>
              </div>

              {isOpen && (
                <div className="mt-3 border-t border-border/40 pt-2">
                  <form
                    className="mb-2 flex gap-2"
                    onSubmit={(e) => { e.preventDefault(); runSearch(searchTerm); }}
                  >
                    <input
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder="在曲库里搜（繁简、副标题不同也能找）"
                      className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                    />
                    <button type="submit" className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg">
                      搜
                    </button>
                  </form>

                  {searching && <p className="text-xs text-muted">搜索中…</p>}
                  {!searching && !results.length && (
                    <p className="text-xs text-muted">曲库里没找到，换个关键词试试。</p>
                  )}

                  <ul className="space-y-1">
                    {results.map((t) => (
                      <li key={`${t.source}:${t.externalId}`} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs text-muted">
                          {t.title} · {t.artist} · {formatDuration(t.durationSec)}
                          {" · "}{SOURCE_LABEL[t.source] || t.source}
                          {t.vipOnly && <span className="ml-1 text-amber-300">VIP</span>}
                        </span>
                        <button
                          type="button"
                          onClick={() => configure(row, t)}
                          disabled={busy === `cfg:${row.rawText}`}
                          className="shrink-0 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
                        >
                          就是这个
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {truncated && (
        <p className="mt-3 text-center text-xs text-muted">
          只显示了前 100 条，用搜索缩小范围。
        </p>
      )}
    </div>
  );
}
