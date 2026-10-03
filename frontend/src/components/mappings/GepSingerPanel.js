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
 * the destination list: the song they find is offered as 待确认. Never liked
 * automatically — the user still decides, so a wrong entry here costs a click.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { mappingAPI } from "@/lib/api";

const errorOf = (err, fallback) => err?.response?.data?.error?.message || fallback;

function SongRow({ song, onChanged, onDeleted }) {
  const [alias, setAlias] = useState("");
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
      onChanged({
        ...song,
        aliases: song.aliases.some((a) => a.id === res.data.id) ? song.aliases : [...song.aliases, res.data],
      });
    });
  };

  const removeAlias = (id) => run(async () => {
    await mappingAPI.removeGepAlias(id);
    onChanged({ ...song, aliases: song.aliases.filter((a) => a.id !== id) });
  });

  const remove = () => run(async () => {
    await mappingAPI.removeGepSong(song.id);
    onDeleted(song.id);
  });

  return (
    <li className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words font-medium text-fg">《{song.title}》</p>
          {song.source === "manual" && <p className="text-[0.7rem] text-muted">手动添加</p>}
        </div>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={remove}
              className="rounded border border-red-500/50 px-2 py-0.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40"
            >确定删除</button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded border border-border px-2 py-0.5 text-xs text-muted hover:text-fg"
            >取消</button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted hover:border-red-500/50 hover:text-red-300"
          >删除</button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted">网站歌名：</span>
        {song.aliases.length === 0 && <span className="text-xs text-muted">（无）</span>}
        {song.aliases.map((a) => (
          <span key={a.id} className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs text-fg">
            {a.siteTitle}
            <button
              type="button"
              disabled={busy}
              onClick={() => removeAlias(a.id)}
              title="删除这个网站歌名"
              className="text-muted hover:text-red-300 disabled:opacity-40"
            >×</button>
          </span>
        ))}
      </div>
      <form onSubmit={addAlias} className="mt-2 flex gap-2">
        <input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          maxLength={120}
          placeholder="添加网站上的写法，如：Can You Feel My World (Live)"
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !alias.trim()}
          className="shrink-0 rounded-lg border border-accent px-3 py-1.5 text-sm text-accent disabled:opacity-40"
        >添加</button>
      </form>
      {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
    </li>
  );
}

export default function GepSingerPanel() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
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

  const loadSingers = useCallback(async (q) => {
    const mine = ++lastSearch.current;
    setLoading(true);
    setError("");
    try {
      const res = await mappingAPI.gepSingers(q);
      if (mine === lastSearch.current) setSingers(res.data.singers || []);
    } catch (err) {
      if (mine === lastSearch.current) setError(errorOf(err, "读取失败"));
    } finally {
      if (mine === lastSearch.current) setLoading(false);
    }
  }, []);

  useEffect(() => { loadSingers(submitted); }, [loadSingers, submitted]);

  const open = useCallback(async (singer) => {
    wanted.current = singer;
    setSelected(singer);
    setSongs([]);
    setSongsLoading(true);
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
  const dropOne = (singer) => setSingers((prev) => prev
    .map((s) => (s.singer === singer ? { ...s, songs: s.songs - 1 } : s))
    .filter((s) => s.songs > 0));

  const addSong = async (e) => {
    e.preventDefault();
    const singer = newSinger.trim();
    const title = newTitle.trim();
    if (!singer || !title) return;
    setAdding(true);
    setError("");
    try {
      const res = await mappingAPI.addGepSong(singer, title);
      setNewTitle("");
      // Show the singer it went under, with the new row in place. A re-add of
      // an existing pair is answered with that same row, so nothing doubles.
      if (selected === singer) {
        setSongs((prev) => (prev.some((s) => s.id === res.data.id)
          ? prev
          : [...prev, res.data].sort((a, b) => a.title.localeCompare(b.title))));
      } else {
        await open(singer);
      }
      // Counts from the server rather than guessed here.
      loadSingers(submitted);
    } catch (err) {
      setError(errorOf(err, "添加失败"));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        歌P 一局只有一位指定歌手，双方轮流唱这位歌手的歌。打标 APK（v28 起）会把歌名和歌手一起发上来，记在这里。
        识别错了、或游戏里已经没有的，可以删除；没记到的可以手动添加。给歌名加上「网站歌名」后，
        以后这首歌在歌单 / QQ 歌单里对不上时，会按网站歌名找到并放进「待确认」，由用户自己点，不会自动点赞。
      </p>

      <div className="mb-3 flex flex-wrap gap-2">
        <form
          className="flex min-w-[16rem] flex-1 gap-2"
          onSubmit={(e) => { e.preventDefault(); setSubmitted(query.trim()); }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索歌手或歌名…"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-fg">搜索</button>
        </form>
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
            <p className="py-6 text-center text-sm text-muted">{submitted ? "没有匹配的歌手。" : "还没有记录。"}</p>
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
                  <span className="shrink-0 rounded bg-black/20 px-1.5 py-0.5 text-xs tabular-nums">{s.songs}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          {!selected && <p className="py-6 text-center text-sm text-muted">选一位歌手，查看见过的全部歌名。</p>}
          {selected && (
            <>
              <h3 className="mb-2 text-sm font-semibold">
                {selected}
                <span className="ml-2 text-xs font-normal text-muted">{songs.length} 首</span>
              </h3>
              {songsLoading && <p className="py-6 text-center text-sm text-muted">读取中…</p>}
              <ul className="space-y-2">
                {songs.map((song) => (
                  <SongRow
                    key={song.id}
                    song={song}
                    onChanged={(next) => setSongs((prev) => prev.map((x) => (x.id === next.id ? next : x)))}
                    onDeleted={(id) => {
                      setSongs((prev) => prev.filter((x) => x.id !== id));
                      dropOne(selected);
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
