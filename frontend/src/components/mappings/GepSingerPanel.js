"use client";

/**
 * 歌P 歌手 — which songs the game has offered under which singer.
 *
 * A 歌P game names one singer and both teams sing that singer's songs, so the
 * capture client (v28+) sends the singer with every title and the server
 * records the pair. This tab is where those pairs are looked at and kept
 * right: delete what was misread or is no longer in the game, add what is
 * missing, and attach to a title how the site / the platform playlist writes
 * it (「网站歌名」).
 *
 * The attached titles are used when a captured 歌P title matches nothing in
 * the destination list. What they find is liked on its own only when it is
 * one song credited to the game's singer; otherwise it goes to 待确认.
 *
 * 待处理 marks a title a 歌P capture could not match: on the playlist page,
 * nothing in the playlist called exactly this; in QQ打标, nothing on the site
 * called exactly this (what is in a user's QQ list is unknown to us). A
 * 网站歌名 that finds a song on the site settles it; one that finds nothing
 * does not. Adding one clears the mark; 已处理 clears it until the next capture.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import api, { mappingAPI, playlistsAPI } from "@/lib/api";

const errorOf = (err, fallback) => err?.response?.data?.error?.message || fallback;

/**
 * 最近出现 is kept to the Beijing day, so it is shown as one too, wherever the
 * reader is: "11/8", with the year only when it is not this one.
 */
const beijingDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" });
function dayLabel(iso) {
  const ymd = (d) => Object.fromEntries(beijingDate.formatToParts(d).map((p) => [p.type, p.value]));
  const d = ymd(new Date(iso));
  const md = `${Number(d.month)}/${Number(d.day)}`;
  return d.year === ymd(new Date()).year ? md : `${d.year}/${md}`;
}

function SongRow({ song, onChanged, onDeleted }) {
  const [alias, setAlias] = useState("");
  // Most titles match the site exactly and never need a 网站歌名, so the box
  // is only there once asked for.
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorOf(err, "操作失败"));
    } finally {
      setBusy(false);
    }
  };

  const addAlias = (e) => {
    e.preventDefault();
    const t = alias.trim();
    if (!t) return;
    run(async () => {
      const res = await mappingAPI.addGepAlias(song.id, t);
      setAlias("");
      setAdding(false);
      onChanged({
        ...song,
        // Adding one clears 待处理 on the server too.
        needsReviewAt: null,
        aliases: song.aliases.some((a) => a.id === res.data.id) ? song.aliases : [...song.aliases, res.data],
      });
    });
  };

  const removeAlias = (id) => run(async () => {
    await mappingAPI.removeGepAlias(id);
    onChanged({ ...song, aliases: song.aliases.filter((a) => a.id !== id) });
  });

  const markReviewed = () => run(async () => {
    await api.post(`/mappings/gep-singers/songs/${song.id}/reviewed`);
    onChanged({ ...song, needsReviewAt: null });
  });

  const remove = () => run(async () => {
    await mappingAPI.removeGepSong(song.id);
    onDeleted(song.id);
  });

  const small = "shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted hover:text-fg disabled:opacity-40";

  return (
    <li className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="break-words font-medium text-fg">《{song.title}》</span>
        {song.needsReviewAt && (
          <span
            className="rounded bg-yellow-500/15 px-1.5 py-0.5 text-[0.65rem] text-yellow-500"
            title={`最近一次：${new Date(song.needsReviewAt).toLocaleString()}`}
          >待处理</span>
        )}
        {song.source === "manual" && <span className="text-[0.7rem] text-muted">手动添加</span>}
        {song.lastSeenAt && (
          <span className="text-[0.7rem] tabular-nums text-muted" title="游戏里最近一次出现的日期（北京时间）">
            最近 {dayLabel(song.lastSeenAt)}
          </span>
        )}
        {song.aliases.map((a) => (
          <span key={a.id} className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs text-fg">
            <span className="text-muted">→</span>{a.siteTitle}
            <button
              type="button"
              disabled={busy}
              onClick={() => removeAlias(a.id)}
              title="删除这个网站歌名"
              className="text-muted hover:text-red-300 disabled:opacity-40"
            >×</button>
          </span>
        ))}

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {!adding && (
            <button type="button" onClick={() => setAdding(true)} className={small}>添加映射</button>
          )}
          {song.needsReviewAt && (
            <button type="button" disabled={busy} onClick={markReviewed} className={small} title="看过了，不需要加网站歌名">已处理</button>
          )}
          {confirming ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={remove}
                className="rounded border border-red-500/50 px-2 py-0.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40"
              >确定删除</button>
              <button type="button" onClick={() => setConfirming(false)} className={small}>取消</button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted hover:border-red-500/50 hover:text-red-300"
            >删除</button>
          )}
        </span>
      </div>

      {adding && (
        <form onSubmit={addAlias} className="mt-2 flex gap-2">
          <input
            autoFocus
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            maxLength={120}
            placeholder="网站或 QQ 音乐上的歌名，如：Can You Feel My World (Live)"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !alias.trim()}
            className="shrink-0 rounded-lg border border-accent px-3 py-1.5 text-sm text-accent disabled:opacity-40"
          >添加</button>
          <button
            type="button"
            onClick={() => { setAdding(false); setAlias(""); }}
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
          >取消</button>
        </form>
      )}
      {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
    </li>
  );
}

const smallBtn = "shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted hover:text-fg disabled:opacity-40";

/**
 * 对比歌单: this singer's titles that the chosen playlist (own, or shared with
 * you) does not have. Read-only -- it only lists them. The playlist is held by
 * the parent, so it stays chosen from one singer to the next.
 */
function CompareBox({ singer, playlists, playlistsError, playlistId, onPick, onClose }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // The last comparison asked for; an older answer is dropped.
  const last = useRef(0);

  const run = useCallback(async () => {
    const mine = ++last.current;
    setResult(null);
    setError("");
    if (!playlistId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // Called here rather than added to mappingAPI: lib/api is in every
      // page's bundle, and this is used on this tab only.
      const res = await api.get("/mappings/gep-singers/compare", { params: { singer, playlistId } });
      if (mine === last.current) setResult(res.data);
    } catch (err) {
      if (mine === last.current) setError(errorOf(err, "对比失败"));
    } finally {
      if (mine === last.current) setLoading(false);
    }
  }, [singer, playlistId]);

  useEffect(() => { run(); }, [run]);

  const own = (playlists || []).filter((p) => p.isOwner);
  const shared = (playlists || []).filter((p) => !p.isOwner);

  return (
    <div className="mb-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-xs text-muted">对比歌单</span>
        <select
          value={playlistId}
          onChange={(e) => onPick(e.target.value)}
          disabled={!playlists}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">
            {!playlists ? (playlistsError ? "歌单读取失败" : "读取歌单中…") : playlists.length ? "选一个歌单…" : "没有可选的歌单"}
          </option>
          {own.length > 0 && (
            <optgroup label="我的歌单">
              {own.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
          )}
          {shared.length > 0 && (
            <optgroup label="分享给我的">
              {shared.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.ownerName}</option>)}
            </optgroup>
          )}
        </select>
        {playlistId && (
          <button type="button" onClick={run} disabled={loading} className={smallBtn} title="加了网站歌名或改了歌单后，再比一次">重新对比</button>
        )}
        <button type="button" onClick={onClose} className={smallBtn}>收起</button>
      </div>

      {playlistsError && <p className="mt-2 text-xs text-red-300">{playlistsError}</p>}
      {loading && <p className="mt-2 text-sm text-muted">对比中…</p>}
      {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
      {result && result.missing.length === 0 && (
        <p className="mt-2 text-sm text-accent">「{result.playlist.name}」里这 {result.total} 首都有。</p>
      )}
      {result && result.missing.length > 0 && (
        <>
          <p className="mt-2 text-sm text-fg">
            「{result.playlist.name}」缺 <span className="font-semibold tabular-nums">{result.missing.length}</span> 首
            <span className="text-muted">（共 {result.total} 首）</span>：
          </p>
          <ul className="mt-1 space-y-1">
            {result.missing.map((m) => (
              <li key={m.id} className="break-words text-sm text-fg">
                《{m.title}》
                {m.siteTitles.length > 0 && (
                  <span className="ml-1 text-xs text-muted">网站歌名：{m.siteTitles.join(" / ")}</span>
                )}
                {m.near.length > 0 && (
                  <span className="ml-1 text-xs text-yellow-500">歌单里有「{m.near.join("」「")}」，括号里不同</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function GepSingerPanel() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  // 只看待处理: singers with something to do, and only those songs.
  const [reviewOnly, setReviewOnly] = useState(false);
  const [singers, setSingers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [songs, setSongs] = useState([]);
  const [songsLoading, setSongsLoading] = useState(false);
  const [newSinger, setNewSinger] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);
  // The singer whose songs were asked for last; an older answer is dropped.
  const wanted = useRef(null);
  // Likewise the last search, for the singer list.
  const lastSearch = useRef(0);
  // 对比歌单: open or not, the playlists to pick from (read once, when first
  // opened), and the one picked -- kept while moving between singers.
  const [compareOpen, setCompareOpen] = useState(false);
  const [comparePlaylists, setComparePlaylists] = useState(null);
  const [comparePlaylistsError, setComparePlaylistsError] = useState("");
  const [comparePlaylistId, setComparePlaylistId] = useState("");

  const openCompare = async () => {
    setCompareOpen(true);
    if (comparePlaylists) return;
    setComparePlaylistsError("");
    try {
      const res = await playlistsAPI.list();
      // Own and shared with you; not public ones or copy-only ones.
      setComparePlaylists((res.data.playlists || []).filter((p) => p.isOwner || p.isShared));
    } catch (err) {
      setComparePlaylistsError(errorOf(err, "歌单读取失败"));
    }
  };

  const loadSingers = useCallback(async (q, review) => {
    const mine = ++lastSearch.current;
    setLoading(true);
    setError("");
    try {
      const params = {};
      if (q) params.q = q;
      if (review) params.review = "1";
      const res = await api.get("/mappings/gep-singers", { params });
      if (mine === lastSearch.current) setSingers(res.data.singers || []);
    } catch (err) {
      if (mine === lastSearch.current) setError(errorOf(err, "读取失败"));
    } finally {
      if (mine === lastSearch.current) setLoading(false);
    }
  }, []);

  useEffect(() => { loadSingers(submitted, reviewOnly); }, [loadSingers, submitted, reviewOnly]);

  // `quiet`: refresh in place (after an add) rather than blanking the list.
  const open = useCallback(async (singer, { quiet = false } = {}) => {
    wanted.current = singer;
    setSelected(singer);
    if (!quiet) {
      setSongs([]);
      setSongsLoading(true);
    }
    setError("");
    try {
      const res = await mappingAPI.gepSongs(singer);
      if (wanted.current === singer) setSongs(res.data.songs || []);
    } catch (err) {
      if (wanted.current === singer) setError(errorOf(err, "读取失败"));
    } finally {
      if (wanted.current === singer) setSongsLoading(false);
    }
  }, []);

  // One song deleted: its singer counts one fewer, and leaves the list at zero.
  const dropOne = (singer, wasFlagged) => setSingers((prev) => prev
    .map((s) => (s.singer === singer
      ? { ...s, songs: s.songs - 1, review: Math.max(0, (s.review || 0) - (wasFlagged ? 1 : 0)) }
      : s))
    .filter((s) => s.songs > 0 && (!reviewOnly || s.review > 0)));

  // A song's 待处理 cleared here: one fewer on its singer, who leaves the
  // 只看待处理 list at zero.
  const reviewedOne = (singer) => setSingers((prev) => prev
    .map((s) => (s.singer === singer ? { ...s, review: Math.max(0, (s.review || 0) - 1) } : s))
    .filter((s) => !reviewOnly || s.review > 0));

  const addSong = async (e) => {
    e.preventDefault();
    const singer = newSinger.trim();
    const title = newTitle.trim();
    if (!singer || !title) return;
    setAdding(true);
    setError("");
    try {
      await mappingAPI.addGepSong(singer, title);
      setNewTitle("");
      // The server's order (pinyin), with the new row in place.
      await open(singer, { quiet: selected === singer });
      // Counts from the server rather than guessed here.
      loadSingers(submitted, reviewOnly);
    } catch (err) {
      setError(errorOf(err, "添加失败"));
    } finally {
      setAdding(false);
    }
  };

  const shown = reviewOnly ? songs.filter((s) => s.needsReviewAt) : songs;

  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        歌P 一局只有一位指定歌手，双方轮流唱这位歌手的歌。打标 APK（v28 起）会把歌名和歌手一起发上来，记在这里。
        识别错了、或游戏里已经没有的，可以删除；没记到的可以手动添加。给歌名加上「网站歌名」后，
        以后这首歌在歌单 / QQ 歌单里对不上时会按网站歌名去找：找到唯一一首、且是这位歌手的，自动打标；否则放进「待确认」由用户自己点。
        「待处理」= 歌P 里抓到这首歌时对不上：歌单页是歌单里没有完全一致的歌名，QQ打标是网站上没有同名的歌。
        加上网站上找得到的网站歌名就不再标；加了但网站上找不到的，仍会再标。
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <form
          className="flex min-w-[16rem] flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const q = query.trim();
            // The same search again still reloads: it is how to see what changed.
            if (q === submitted) loadSingers(q, reviewOnly);
            else setSubmitted(q);
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索歌手或歌名…"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-fg">搜索</button>
        </form>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-sm text-muted">
          <input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} />
          只看待处理
        </label>
      </div>

      <form onSubmit={addSong} className="mb-4 flex flex-wrap gap-2 rounded-lg border border-border bg-surface p-3">
        <span className="w-full text-xs text-muted">手动添加一首</span>
        <input
          value={newSinger}
          onChange={(e) => setNewSinger(e.target.value)}
          maxLength={64}
          placeholder="歌手"
          className="min-w-[8rem] flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
        />
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          maxLength={120}
          placeholder="游戏里的歌名（《》可带可不带）"
          className="min-w-[14rem] flex-[2] rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={adding || !newSinger.trim() || !newTitle.trim()}
          className="shrink-0 rounded-lg border border-accent px-3 py-1.5 text-sm text-accent disabled:opacity-40"
        >添加</button>
      </form>

      {error && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-[minmax(10rem,16rem)_1fr]">
        <div>
          {loading && <p className="py-6 text-center text-sm text-muted">读取中…</p>}
          {!loading && singers.length === 0 && (
            <p className="py-6 text-center text-sm text-muted">
              {reviewOnly ? "没有待处理的歌。" : submitted ? "没有匹配的歌手。" : "还没有记录。"}
            </p>
          )}
          <ul className="max-h-[32rem] space-y-1 overflow-y-auto pr-1">
            {singers.map((s) => (
              <li key={s.singer}>
                <button
                  type="button"
                  onClick={() => open(s.singer)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
                    selected === s.singer
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border bg-surface text-fg hover:border-accent/50"
                  }`}
                >
                  <span className="truncate">{s.singer}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {s.review > 0 && (
                      <span className="rounded bg-yellow-500/15 px-1.5 py-0.5 text-xs tabular-nums text-yellow-500" title="待处理">{s.review}</span>
                    )}
                    <span className="rounded bg-black/20 px-1.5 py-0.5 text-xs tabular-nums">{s.songs}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          {!selected && <p className="py-6 text-center text-sm text-muted">选一位歌手，查看见过的全部歌名。</p>}
          {selected && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {selected}
                  <span className="ml-2 text-xs font-normal text-muted">
                    {reviewOnly ? `${shown.length} 首待处理 / 共 ${songs.length} 首` : `${songs.length} 首`}
                  </span>
                </h3>
                {!compareOpen && (
                  <button type="button" onClick={openCompare} className={`ml-auto ${smallBtn}`}>对比歌单</button>
                )}
              </div>
              {compareOpen && (
                <CompareBox
                  singer={selected}
                  playlists={comparePlaylists}
                  playlistsError={comparePlaylistsError}
                  playlistId={comparePlaylistId}
                  onPick={setComparePlaylistId}
                  onClose={() => setCompareOpen(false)}
                />
              )}
              {songsLoading && <p className="py-6 text-center text-sm text-muted">读取中…</p>}
              {!songsLoading && reviewOnly && songs.length > 0 && shown.length === 0 && (
                <p className="py-6 text-center text-sm text-muted">这位歌手没有待处理的歌了。</p>
              )}
              <ul className="space-y-1.5">
                {shown.map((song) => (
                  <SongRow
                    key={song.id}
                    song={song}
                    onChanged={(next) => {
                      if (song.needsReviewAt && !next.needsReviewAt) reviewedOne(selected);
                      setSongs((prev) => prev.map((x) => (x.id === next.id ? next : x)));
                    }}
                    onDeleted={(id) => {
                      setSongs((prev) => prev.filter((x) => x.id !== id));
                      dropOne(selected, Boolean(song.needsReviewAt));
                    }}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
