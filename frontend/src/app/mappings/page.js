"use client";

/**
 * Song-mapping review.
 *
 * A mapping says "when the game shows this title and artist, play this exact
 * track". Approving one changes what plays for everybody, which is why the
 * page is limited to admins and the few users given the canEditMapping flag,
 * and why it is not linked from the navigation.
 *
 * Reviewing is mostly listening: two seconds of audio settles whether a
 * pairing is right far quicker than reading metadata. So every row has a play
 * button, and the audio streams from the platform CDN straight to the browser.
 *
 * Three tabs, because a row is in one of three genuinely different states —
 * approved, awaiting a decision, or an imported track the game has never shown
 * yet. That last count is the useful one to watch: it only falls as songs
 * actually turn up in play.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { mappingAPI, musicSourcesAPI } from "@/lib/api";
import useAuth from "@/hooks/useAuth";

const BUCKETS = [
  { key: "pending", label: "待确认", hint: "等待人工判断" },
  { key: "confirmed", label: "已确认", hint: "已批准，播放时直接使用" },
  { key: "unseen", label: "未遇见", hint: "已导入，但游戏里还没出现过" },
];

const SOURCE_LABEL = { LOCAL: "曲库", QQ: "QQ", NETEASE: "网易" };

function formatDuration(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export default function MappingsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [bucket, setBucket] = useState("pending");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ confirmed: 0, pending: 0, unseen: 0 });
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);

  const [expanded, setExpanded] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [busy, setBusy] = useState(null);
  const [claimFor, setClaimFor] = useState(null);
  const [gameTitle, setGameTitle] = useState("");
  const [gameArtist, setGameArtist] = useState("");

  const [playing, setPlaying] = useState(null);
  // Which row the audio element currently holds. Kept apart from `playing` so
  // pausing does not discard the loaded track and the scrub position with it.
  const [loadedFor, setLoadedFor] = useState(null);
  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [playError, setPlayError] = useState("");
  // Reviewing depends on a working QQ connection, so its health belongs on
  // this page too — otherwise a dying credential shows up only as playback
  // that silently stops working.
  const [credential, setCredential] = useState(null);
  const audioRef = useRef(null);

  const load = useCallback(async ({ append = false, cursor = null } = {}) => {
    setLoading(true);
    setError("");
    try {
      const res = await mappingAPI.list({ bucket, q: query, cursor, take: 50 });
      setRows((prev) => (append ? [...prev, ...res.data.rows] : res.data.rows));
      setNextCursor(res.data.nextCursor);
      if (res.data.counts) setCounts(res.data.counts);
    } catch (err) {
      // A 403 here means the account simply lacks the flag; say so plainly
      // rather than showing an empty list that looks like a bug.
      if (err.response?.status === 403) setDenied(true);
      else setError(err.response?.data?.error?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [bucket, query]);

  useEffect(() => {
    if (authLoading || !user) return;
    load();
    musicSourcesAPI.get('qq').then((r) => setCredential(r.data.source)).catch(() => {});
  }, [authLoading, user, load]);

  useEffect(() => {
    if (!authLoading && !user) router.push("/login");
  }, [authLoading, user, router]);

  // Stop the audio when the page goes away, or it keeps playing over whatever
  // the user navigates to next.
  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
  }, []);

  const toggleExpand = useCallback(async (row) => {
    if (expanded === row.id) {
      setExpanded(null);
      setCandidates([]);
      return;
    }
    setExpanded(row.id);
    setCandidates([]);
    if (row.kind === "mapping") {
      try {
        const res = await mappingAPI.candidates(row.id);
        setCandidates(res.data.candidates);
      } catch {
        setCandidates([]);
      }
    }
  }, [expanded]);

  /**
   * Attach the shared audio element, wiring up progress.
   *
   * Recognising a song is not always instant: two same-titled recordings can
   * open identically and only diverge at the chorus, so a reviewer needs to
   * scrub rather than judge from the first seconds.
   */
  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;
    const el = new Audio();
    el.preload = "metadata";
    el.addEventListener("timeupdate", () => {
      setProgress({ current: el.currentTime || 0, duration: el.duration || 0 });
    });
    el.addEventListener("loadedmetadata", () => {
      setProgress({ current: el.currentTime || 0, duration: el.duration || 0 });
    });
    el.addEventListener("ended", () => setPlaying(null));
    audioRef.current = el;
    return el;
  }, []);

  const play = useCallback(async (row) => {
    setPlayError("");
    const el = ensureAudio();

    // Same row again: pause or resume, keeping the position so scrubbing is
    // not undone by a stray click on the button.
    if (playing === row.id) {
      el.pause();
      setPlaying(null);
      return;
    }
    if (loadedFor === row.id && el.src) {
      await el.play().catch(() => {});
      setPlaying(row.id);
      return;
    }

    setBusy(`play:${row.id}`);
    try {
      const res = await mappingAPI.preview(row.id);
      const { url, reason } = res.data;
      if (!url) {
        // A track the platform will not serve is a permissions answer, not a
        // fault, and the fix is different — so it is worded differently.
        setPlayError(reason === "unavailable"
          ? "这首歌当前拿不到播放地址（可能需要会员或已下架）"
          : "无法试听");
        return;
      }
      el.src = url;
      setProgress({ current: 0, duration: 0 });
      setLoadedFor(row.id);
      await el.play();
      setPlaying(row.id);
    } catch (err) {
      setPlayError(err.response?.data?.error?.message || "试听失败");
    } finally {
      setBusy(null);
    }
  }, [playing, loadedFor, ensureAudio]);

  const seek = useCallback((fraction) => {
    const el = audioRef.current;
    if (!el || !el.duration) return;
    el.currentTime = Math.max(0, Math.min(1, fraction)) * el.duration;
  }, []);

  const act = useCallback(async (fn, id, after) => {
    setBusy(id);
    setError("");
    try {
      const res = await fn();
      if (res.data.counts) setCounts(res.data.counts);
      after?.(res);
    } catch (err) {
      setError(err.response?.data?.error?.message || "操作失败");
    } finally {
      setBusy(null);
    }
  }, []);

  const approve = (row, target) => act(
    () => mappingAPI.approve(row.id, target ? { source: target.source, externalId: target.externalId } : {}),
    row.id,
    () => { setRows((prev) => prev.filter((r) => r.id !== row.id)); setExpanded(null); },
  );

  const unapprove = (row) => act(
    () => mappingAPI.unapprove(row.id),
    row.id,
    () => setRows((prev) => prev.filter((r) => r.id !== row.id)),
  );

  const remove = (row) => act(
    () => mappingAPI.remove(row.id),
    row.id,
    () => setRows((prev) => prev.filter((r) => r.id !== row.id)),
  );

  const claim = (track) => act(
    () => mappingAPI.create({
      gameTitle: gameTitle.trim(),
      gameArtist: gameArtist.trim(),
      source: track.source,
      externalId: track.externalId,
    }),
    track.id,
    () => {
      setRows((prev) => prev.filter((r) => r.id !== track.id));
      setClaimFor(null);
      setGameTitle("");
      setGameArtist("");
    },
  );

  if (authLoading) return <div className="p-8 text-muted">加载中…</div>;

  if (denied) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <div className="rounded-xl border border-border bg-surface p-6">
          <h1 className="mb-2 text-lg font-semibold">没有权限</h1>
          <p className="text-sm text-muted">
            这个页面只对管理员和被授予标注权限的账号开放。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">歌曲映射审核</h1>
        <p className="mt-1 text-sm text-muted">
          一条映射决定「游戏里显示这个名字时，播放哪一首」。批准后全站生效，
          并且不再被自动搜索覆盖。
        </p>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            title={b.hint}
            onClick={() => {
              // Stop the audio: the row it belongs to is about to disappear
              // from the list, and music playing over an unrelated tab is
              // disorienting.
              audioRef.current?.pause();
              setPlaying(null);
              setLoadedFor(null);
              setBucket(b.key);
              setExpanded(null);
              setNextCursor(null);
            }}
            className={`rounded-lg border px-3 py-2 text-sm transition ${
              bucket === b.key
                ? "border-accent bg-accent/10 text-accent"
                : "border-border bg-surface text-muted hover:text-fg"
            }`}
          >
            {b.label}
            <span className="ml-2 rounded bg-black/20 px-1.5 py-0.5 text-xs tabular-nums">
              {counts[b.key] ?? 0}
            </span>
          </button>
        ))}
      </div>

      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => { e.preventDefault(); load(); }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索歌名或歌手…"
          className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button type="submit" className="rounded-lg border border-border bg-surface px-4 py-2 text-sm hover:border-accent">
          搜索
        </button>
      </form>

      {/* Reviewing means listening, and listening needs a live connection.
          Surfaced here so a dying credential is visible before playback stops
          working, rather than after. */}
      {credential && credential.connected && credential.level !== "ok" && (
        <div
          className={`mb-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
            credential.level === "soon"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
              : "border-red-500/40 bg-red-500/10 text-red-300"
          }`}
        >
          <span>
            {credential.level === 'expired'
              ? 'QQ 音乐连接已过期，试听将会失败'
              : 'QQ 音乐连接即将过期'}
          </span>
          <a href="/account" className="underline underline-offset-2 hover:opacity-80">去账号页处理</a>
        </div>
      )}
      {credential && !credential.connected && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">
          <span>尚未连接 QQ 音乐，无法试听。</span>
          <a href="/account" className="underline underline-offset-2 hover:text-fg">去连接</a>
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      {playError && (
        <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          {playError}
        </div>
      )}

      {loading && rows.length === 0 && <div className="p-6 text-sm text-muted">加载中…</div>}

      {!loading && rows.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-6 text-sm text-muted">
          {query ? "没有匹配的结果。" : "这个分类目前是空的。"}
        </div>
      )}

      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id} className="rounded-xl border border-border bg-surface">
            <div className="flex items-center gap-3 p-3">
              <button
                type="button"
                onClick={() => play(row)}
                disabled={busy === `play:${row.id}` || row.kind === "imported"}
                title={row.kind === "imported" ? "先认领后才能试听" : "试听"}
                className="h-9 w-9 shrink-0 rounded-full border border-border text-sm disabled:opacity-30 hover:border-accent"
              >
                {busy === `play:${row.id}` ? "…" : playing === row.id ? "❚❚" : "▶"}
              </button>

              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {row.title}
                  <span className="text-muted"> — {row.artist || "（无歌手）"}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="rounded bg-black/20 px-1.5 py-0.5">
                    {SOURCE_LABEL[row.source] || row.source}
                  </span>
                  <span>{formatDuration(row.durationSec)}</span>
                  {row.vipOnly && <span className="text-amber-400">需会员</span>}
                  {/* The platform regularly names the artist differently from
                      the game (凤凰传奇 against 玲花/曾毅). Showing both is how a
                      reviewer tells a real mismatch from a naming difference. */}
                  {row.platformArtist && row.platformArtist !== row.artist && (
                    <span className="truncate">平台：{row.platformTitle} — {row.platformArtist}</span>
                  )}
                  {row.matchKind && <span>匹配：{row.matchKind}</span>}
                  {row.approvedBy && <span>由 {row.approvedBy} 确认</span>}
                </div>
              </div>

              <div className="flex shrink-0 gap-1.5">
                {row.kind === "mapping" && !row.approved && (
                  <button
                    type="button"
                    onClick={() => approve(row)}
                    disabled={busy === row.id}
                    className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    就是这个
                  </button>
                )}
                {row.kind === "mapping" && row.approved && (
                  <button
                    type="button"
                    onClick={() => unapprove(row)}
                    disabled={busy === row.id}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-fg disabled:opacity-50"
                  >
                    撤销确认
                  </button>
                )}
                {row.kind === "imported" && (
                  <button
                    type="button"
                    onClick={() => { setClaimFor(claimFor === row.id ? null : row.id); setGameTitle(row.title); setGameArtist(row.artist); }}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs hover:border-accent"
                  >
                    认领
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => toggleExpand(row)}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:text-fg"
                >
                  {expanded === row.id ? "▴" : "▾"}
                </button>
              </div>
            </div>

            {loadedFor === row.id && (
              <div className="flex items-center gap-2 px-3 pb-3">
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted">
                  {formatDuration(Math.floor(progress.current))}
                </span>
                {/* A range input rather than a custom track: it is draggable,
                    keyboard-accessible and click-to-position for free. */}
                <input
                  type="range"
                  min={0}
                  max={1000}
                  value={progress.duration ? Math.round((progress.current / progress.duration) * 1000) : 0}
                  onChange={(e) => seek(Number(e.target.value) / 1000)}
                  aria-label="播放进度"
                  className="h-1 flex-1 cursor-pointer accent-accent"
                />
                <span className="w-10 shrink-0 text-xs tabular-nums text-muted">
                  {formatDuration(Math.floor(progress.duration))}
                </span>
                {/* Jumping straight to the middle is the fastest way to tell
                    two same-titled recordings apart. */}
                <button
                  type="button"
                  onClick={() => seek(0.4)}
                  title="跳到中段"
                  className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted hover:text-fg"
                >
                  副歌
                </button>
              </div>
            )}

            {claimFor === row.id && (
              <div className="border-t border-border p-3">
                <p className="mb-2 text-xs text-muted">
                  游戏里显示的歌名和歌手是什么？映射用它作为查询的键。
                </p>
                <div className="flex flex-wrap gap-2">
                  <input
                    value={gameTitle}
                    onChange={(e) => setGameTitle(e.target.value)}
                    placeholder="游戏里的歌名"
                    className="min-w-[10rem] flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                  <input
                    value={gameArtist}
                    onChange={(e) => setGameArtist(e.target.value)}
                    placeholder="游戏里的歌手"
                    className="min-w-[10rem] flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => claim(row)}
                    disabled={!gameTitle.trim() || busy === row.id}
                    className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300 disabled:opacity-40"
                  >
                    建立映射
                  </button>
                </div>
              </div>
            )}

            {expanded === row.id && row.kind === "mapping" && (
              <div className="border-t border-border p-3">
                <div className="mb-2 text-xs text-muted">
                  键：{row.titleKey} | {row.artistKey || "（无歌手）"}
                </div>
                {candidates.length === 0 ? (
                  <p className="text-xs text-muted">曲库池里没有同名的其他候选。</p>
                ) : (
                  <ul className="space-y-1">
                    {candidates.map((c) => (
                      <li
                        key={`${c.source}:${c.externalId}`}
                        className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {c.title} — {c.artist}
                          <span className="ml-2 text-muted">{formatDuration(c.durationSec)}</span>
                          {c.artistMatches && <span className="ml-2 text-emerald-400">歌手吻合</span>}
                          {c.durationMatches && <span className="ml-2 text-emerald-400">时长吻合</span>}
                          {c.vipOnly && <span className="ml-2 text-amber-400">需会员</span>}
                        </span>
                        {c.current ? (
                          <span className="shrink-0 text-muted">当前</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => approve(row, c)}
                            className="shrink-0 rounded border border-border px-2 py-1 hover:border-accent"
                          >
                            改用这个
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => remove(row)}
                    disabled={busy === row.id}
                    className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    删除这条映射
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {nextCursor && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => load({ append: true, cursor: nextCursor })}
            disabled={loading}
            className="rounded-lg border border-border bg-surface px-5 py-2 text-sm hover:border-accent disabled:opacity-50"
          >
            {loading ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </div>
  );
}
