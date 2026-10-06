"use client";

/**
 * QQ打标 — auto-tag into the user's own QQ 音乐 / 网易云 account.
 *
 * Their playlists live on the platform, not here, so this page reads them
 * from the platform (text only, nothing plays), lets the user pick one as the
 * set of songs a game's titles are matched against, and aims the capture
 * connection at it. An exact match is liked straight into the platform's
 * 我喜欢; anything less waits for a click. Every song in the list has its own
 * ♥ too, for liking by hand.
 *
 * The connection is the one the playlist page and 唱卡 use. Aiming it here
 * stops delivery there, exactly as aiming at 唱卡 stops the playlist — one
 * client, one destination at a time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import useAuth from "@/hooks/useAuth";
import useCaptureStore from "@/store/captureStore";
import { musicSourcesAPI, platformTaggingAPI } from "@/lib/api";
import PlatformTagPanel from "@/components/platform/PlatformTagPanel";
import PlatformLikeButton from "@/components/platform/PlatformLikeButton";
// The site's own confirm dialog, as the playlist page's 取消全部喜欢 uses it.
// A plain import: a second lazy importer would make the bundler split it into
// a chunk of its own and change the other pages' builds.
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import * as qqTagReads from "@/lib/qqTagReads";
import * as qqTagWrites from "@/lib/qqTagWrites";

/**
 * Substring match on the server-built search text: the name, its pinyin run
 * together, every polyphonic reading, and the initials. Each space-separated
 * word typed must hit somewhere, so "zjl qt" narrows the way a person expects.
 */
function matchesQuery(searchText, fallback, query) {
  const hay = (searchText || String(fallback || "")).toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * Second chance for a typo. Only when the substring pass found nothing: the
 * query and each word of the search text are compared as bigram sets, and
 * rows scoring at least 0.5 are returned best first. Measured on real search
 * strings: misspellings ("qingtain", "daoxaing") score 0.67-0.88 against
 * their song, unrelated songs stay at or below 0.38. Nothing here calls the
 * server; a few thousand rows is milliseconds.
 */
function bigrams(s) {
  const t = ` ${s} `;
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  let hit = 0;
  A.forEach((x) => { if (B.has(x)) hit += 1; });
  return A.size ? hit / A.size : 0;
}

function fuzzyRank(rows, textOf, query, limit = 20) {
  const q = query.replace(/\s+/g, "");
  if (q.length < 3) return [];
  return rows
    .map((row) => {
      const words = String(textOf(row) || "").toLowerCase().split(/\s+/).filter(Boolean);
      let best = 0;
      for (const w of words) best = Math.max(best, similarity(q, w));
      return { row, best };
    })
    .filter((x) => x.best >= 0.5)
    .sort((a, b) => b.best - a.best)
    .slice(0, limit)
    .map((x) => x.row);
}

const PLATFORM_LABEL = { qq: "QQ 音乐", netease: "网易云" };


/**
 * Where the current run began (开始打标, by the server's clock), so the panel
 * shows this run only -- a new playlist, or this one again after 停止, starts
 * empty, as on the playlist page. Kept across a reload; another browser has no
 * record and shows the whole connection's captures of the list instead.
 */
const RUN_KEY = "qqtag-run";
function rememberRun(run) {
  try { localStorage.setItem(RUN_KEY, JSON.stringify(run)); } catch { /* private mode */ }
}
function recallRun() {
  try {
    const r = JSON.parse(localStorage.getItem(RUN_KEY) || "null");
    return r && r.sessionId && r.ref && r.startedAt ? r : null;
  } catch {
    return null;
  }
}
function forgetRun() {
  try { localStorage.removeItem(RUN_KEY); } catch { /* nothing to do */ }
}

/**
 * QQ lists are read from this browser only (lib/qqTagReads): QQ打标 never
 * reaches QQ from the site's address, not even when the browser's read fails
 * -- the failure is shown instead (2026-10-04). NetEase can only be read by
 * the server, as before.
 */
async function readPlaylists(platform) {
  if (platform === "qq") return qqTagReads.listPlaylists(await qqTagReads.readSession());
  const res = await platformTaggingAPI.playlists(platform);
  return res.data.playlists || [];
}

async function readSongs(sel, { refresh = false, alive = () => true } = {}) {
  if (sel.ref.startsWith("qq:")) {
    const s = await qqTagReads.readSession();
    // What the server already holds for this list (supplied moments ago, or
    // in use by a run) is reused rather than read again -- unless the user
    // asked for a fresh read. Never a read by the server.
    if (!refresh) {
      const hit = await platformTaggingAPI.songs(sel.ref, sel.dirId, sel.isLikes, { cachedOnly: true });
      if (hit.status === 200 && hit.data?.songs) return hit.data;
    }
    return qqTagReads.readPlaylistSongs(s, sel, alive);
  }
  const res = refresh
    ? await platformTaggingAPI.refresh(sel.ref, sel.dirId, sel.isLikes)
    : await platformTaggingAPI.songs(sel.ref, sel.dirId, sel.isLikes);
  return res.data;
}

function errMsg(err, fallback) {
  return err?.response?.data?.error?.message || err?.message || fallback;
}

export default function PlatformTaggingPage() {
  const { user, loading: authLoading, canPlatformTag } = useAuth();
  const connection = useCaptureStore((s) => s.connection);
  const refreshConnection = useCaptureStore((s) => s.refresh);

  const [sources, setSources] = useState(null); // { qq: status, netease: status }
  // A NetEase account is connected but 网易云打标 is not offered.
  const [neteaseHidden, setNeteaseHidden] = useState(false);
  const [platform, setPlatform] = useState(null);
  const [playlists, setPlaylists] = useState([]);
  const [listError, setListError] = useState("");
  const [listLoading, setListLoading] = useState(false);

  const [selected, setSelected] = useState(null); // { ref, dirId, name, count }
  const [songs, setSongs] = useState(null);
  const [songsError, setSongsError] = useState("");
  const [songsLoading, setSongsLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [listFilter, setListFilter] = useState("");
  const [likeBusy, setLikeBusy] = useState(null);

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const restoredRef = useRef(false);

  // Which platforms this account has connected (and which this page offers).
  useEffect(() => {
    if (!user) return;
    Promise.all([
      musicSourcesAPI.list(),
      platformTaggingAPI.config().then((r) => r.data?.netease === true).catch(() => false),
    ])
      .then(([res, netease]) => {
        const map = {};
        (res.data.sources || []).forEach((s) => {
          if (s.platform === "netease" && !netease) { setNeteaseHidden(Boolean(s.connected)); return; }
          map[s.platform] = s;
        });
        setSources(map);
        // First connected platform wins as the default tab; a run already
        // aimed at a platform overrides it below.
        setPlatform((p) => p || ["qq", "netease"].find((k) => map[k]?.connected) || null);
      })
      .catch(() => setSources({}));
  }, [user]);

  // The connection, kept fresh: the panel's session id and the pairing code
  // both come from it, and the client's liveness changes under us.
  useEffect(() => {
    if (!user) return undefined;
    refreshConnection();
    const id = setInterval(refreshConnection, 10000);
    return () => clearInterval(id);
  }, [user, refreshConnection]);

  const aimedRef = connection?.target === "platform" ? connection.platformRef : null;
  const runningHere = Boolean(aimedRef && selected && aimedRef === selected.ref);

  // This run's start, for the panel (see RUN_KEY). Only while it is still the
  // run the connection is on: same connection, same list.
  const [run, setRun] = useState(() => (typeof window === "undefined" ? null : recallRun()));
  const runStartedAt = run && connection?.sessionId === run.sessionId && aimedRef === run.ref
    ? run.startedAt : null;
  // Taken by the playlist page or 唱卡, or a new connection: that run is over
  // (the playlist page forgets its run the same way).
  // Judged only on a connection heard after the run began: the one in hand
  // when 开始 records the run is from before it was aimed.
  const connLoaded = useCaptureStore((st) => st.loaded);
  const seenWhenRunSet = useRef(null);
  useEffect(() => { seenWhenRunSet.current = connection; }, [run]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!run || !connLoaded || connection === seenWhenRunSet.current) return;
    if (!connection || connection.sessionId !== run.sessionId || connection.target !== "platform") {
      forgetRun();
      setRun(null);
    }
  }, [run, connLoaded, connection]);

  // While a QQ run is live, this page performs its automatic likes (the server
  // offers them here first, then to the phone -- never the site's address),
  // and reads the list again when the server has lost its copy (a restart):
  // the server never reads QQ itself.
  const playlistsRef = useRef([]);
  playlistsRef.current = playlists;
  const runSessionId = aimedRef && aimedRef.startsWith("qq:") ? connection?.sessionId || null : null;
  useEffect(() => {
    if (!runSessionId || !aimedRef) return undefined;
    // One re-read at a time, and not again within a few seconds: every
    // capture that finds the list missing asks for it, and each read is the
    // whole list read again from the user's address.
    let inflight = null;
    let lastAt = 0;
    const resupply = () => {
      if (inflight || Date.now() - lastAt < 5000) return inflight;
      inflight = (async () => {
        const sel = playlistsRef.current.find((p) => p.ref === aimedRef);
        if (!sel) return; // read when the list is opened (the songs effect below)
        try {
          const hit = await platformTaggingAPI.songs(sel.ref, sel.dirId, sel.isLikes, { cachedOnly: true });
          if (hit.status === 200) return;
          const data = await readSongs(sel, { refresh: true });
          if (selectedRefNow.current === sel.ref) setSongs(data.songs || []);
        } catch { /* shown when the list is opened */ }
      })().finally(() => { inflight = null; lastAt = Date.now(); });
      return inflight;
    };
    return qqTagWrites.startExecutor(runSessionId, {
      onOpen: resupply,
      onNeedList: (d) => { if (d.playlistRef === aimedRef) resupply(); },
    });
  }, [runSessionId, aimedRef]);

  // A reload mid-run: reopen the playlist the connection is aimed at.
  useEffect(() => {
    if (restoredRef.current || !aimedRef) return;
    restoredRef.current = true;
    const [p] = aimedRef.split(":");
    if (p === "qq" || p === "netease") {
      setPlatform(p);
      // A list from the other platform must not stay selected under the new
      // tab; the effect below re-selects the aimed-at one once the list loads.
      setSelected((cur) => (cur && !cur.ref.startsWith(`${p}:`) ? null : cur));
    }
  }, [aimedRef]);

  // Playlists for the chosen platform.
  useEffect(() => {
    if (!platform || !sources?.[platform]?.connected) { setPlaylists([]); return undefined; }
    let alive = true;
    setListLoading(true);
    setListError("");
    readPlaylists(platform)
      .then((list) => { if (alive) setPlaylists(list); })
      .catch((err) => { if (alive) setListError(errMsg(err, "读取歌单失败")); })
      .finally(() => { if (alive) setListLoading(false); });
    return () => { alive = false; };
  }, [platform, sources]);

  // Once the list is in, select the aimed-at playlist if there is one.
  useEffect(() => {
    if (!aimedRef || selected || !playlists.length) return;
    const hit = playlists.find((p) => p.ref === aimedRef);
    if (hit) setSelected(hit);
  }, [aimedRef, playlists, selected]);

  // Songs of the selected playlist, with their liked state.
  useEffect(() => {
    if (!selected) { setSongs(null); return undefined; }
    let alive = true;
    setSongsLoading(true);
    setSongsError("");
    setUnlikeNote("");
    setFilter("");
    readSongs(selected, { alive: () => alive })
      .then((data) => { if (alive) setSongs(data.songs || []); })
      .catch((err) => { if (alive) { setSongs([]); setSongsError(errMsg(err, "读取歌曲失败")); } })
      .finally(() => { if (alive) setSongsLoading(false); });
    return () => { alive = false; };
  }, [selected]);

  const markLiked = useCallback((id) => {
    setSongs((prev) => prev && prev.map((s) => (String(s.id) === String(id) ? { ...s, alreadyLiked: true } : s)));
  }, []);

  // The heart in the list. Lit → unlike, unlit → like, as on the playlist
  // page. This is the only place an unlike can start: the capture path only
  // ever adds, so a repeated capture can never turn a like off.
  const toggleLike = async (song) => {
    setLikeBusy(song.id);
    setSongsError("");
    try {
      // The song's platform is the one in its playlist ref, never the tab: a
      // QQ id sent as "netease" would act on whatever NetEase track has that
      // number, in the user's real favourites.
      const p = selected.ref.split(":")[0];
      const unliking = song.alreadyLiked;
      let finalOp = unliking ? "unlike" : "like";
      if (p === "qq") {
        // Written by this browser, from the user's own address (never the site's).
        const res = await qqTagWrites.manual({ op: finalOp, id: song.id, songType: song.songType });
        finalOp = res.op;
      } else if (unliking) {
        await platformTaggingAPI.unlike(p, song.id, song.songType, selected.ref);
      } else {
        await platformTaggingAPI.like(p, song.id, song.songType, selected.ref);
      }
      if (finalOp === "unlike") {
        // On the favourites list itself the row is gone, not just unlit.
        setSongs((prev) => prev && (selected.isLikes
          ? prev.filter((s) => String(s.id) !== String(song.id))
          : prev.map((s) => (String(s.id) === String(song.id) ? { ...s, alreadyLiked: false } : s))));
      } else {
        markLiked(song.id);
      }
    } catch (err) {
      setSongsError(errMsg(err, song.alreadyLiked ? "取消点赞失败" : "点赞失败"));
    } finally {
      setLikeBusy(null);
    }
  };

  // 取消全部点赞: every song of this list out of 我喜欢, from this browser
  // (never the site's address), 50 a call. QQ only, and never on 我喜欢
  // itself -- there it would empty the user's whole favourites.
  const [unliking, setUnliking] = useState(null); // { done, total } while running
  const [unlikeNote, setUnlikeNote] = useState("");
  // The same confirm dialog as the playlist page's 取消全部喜欢.
  const [showUnlikeAllConfirm, setShowUnlikeAllConfirm] = useState(false);
  const unlikeAll = async () => {
    if (!selected || !songs || unliking) return;
    const ref = selected.ref;
    const likedNow = songs.filter((s) => s.alreadyLiked).length;
    setUnliking({ done: 0, total: likedNow });
    setUnlikeNote("");
    setSongsError("");
    try {
      const res = await qqTagWrites.unlikeAll({
        songs,
        onProgress: (p) => { if (selectedRefNow.current === ref) setUnliking(p); },
      });
      if (res.removed.length) {
        // Every cached list on the server learns it, in one report.
        platformTaggingAPI.recordedMany({ op: "unlike", ids: res.removed, calls: res.calls }).catch(() => {});
      }
      if (selectedRefNow.current === ref) {
        const gone = new Set(res.removed);
        setSongs((prev) => prev && prev.map((s) => (gone.has(String(s.id)) ? { ...s, alreadyLiked: false } : s)));
        setUnlikeNote(res.remaining.length
          ? `已取消 ${res.removed.length} 首；${res.remaining.length} 首 QQ 没有取消，可以再点一次`
          : `已取消 ${res.removed.length} 首的点赞`);
      }
    } catch (err) {
      // What QQ took before it stopped is reported all the same.
      if (err.removedIds?.length) {
        platformTaggingAPI.recordedMany({ op: "unlike", ids: err.removedIds, calls: err.calls || 0 }).catch(() => {});
      }
      if (selectedRefNow.current === ref) {
        // Some batches may have gone through: show where the list stands
        // now, then the error (the refresh clears the message line).
        setUnliking(null);
        await refreshList();
        if (selectedRefNow.current === ref) setSongsError(`${errMsg(err, "取消失败")}（列表已刷新，可以再点一次）`);
      }
    } finally {
      setUnliking(null);
    }
  };

  const start = async () => {
    if (!selected) return;
    setStarting(true);
    setStartError("");
    try {
      // Ask the server, not the store, whether a connection exists. Opening
      // one ends every other live session for this user — so a store that is
      // merely empty (a poll that failed, a page that just loaded) must not
      // be read as "none", or a client paired from another page is cut off.
      const current = await refreshConnection();
      if (!current && !useCaptureStore.getState().loaded) {
        throw new Error("连接状态未知，请稍后再试");
      }
      // Through this page's own route, so the gate is this feature's add-on.
      if (!current) await platformTaggingAPI.connect({});
      let started;
      try {
        try {
          started = await platformTaggingAPI.start(selected.ref, selected.dirId, selected.isLikes);
        } catch (err) {
          // The server holds no copy of this QQ list (it never reads QQ
          // itself): read it here again, hand it over, and start once more.
          if (err.response?.data?.error?.code !== "QQ_LIST_NOT_LOADED") throw err;
          const data = await readSongs(selected, { refresh: true });
          if (selectedRefNow.current === selected.ref) setSongs(data.songs || []);
          started = await platformTaggingAPI.start(selected.ref, selected.dirId, selected.isLikes);
        }
      } catch (err) {
        // The connection the server knew about has since expired or been
        // stopped elsewhere: open a fresh one and aim once more, the way the
        // playlist page's store heals the same case.
        if (err.response?.status !== 404) throw err;
        await platformTaggingAPI.connect({});
        started = await platformTaggingAPI.start(selected.ref, selected.dirId, selected.isLikes);
      }
      // A new run: the panel starts empty from here.
      const s = started?.data?.session;
      if (s?.id && started.data.startedAt) {
        const r = { sessionId: s.id, ref: selected.ref, startedAt: started.data.startedAt };
        rememberRun(r);
        setRun(r);
      }
      await refreshConnection();
    } catch (err) {
      setStartError(errMsg(err, "开始失败"));
    } finally {
      setStarting(false);
    }
  };

  // Through this page's router too, for the same reason as connect.
  const stop = async () => {
    try {
      await platformTaggingAPI.stop();
      forgetRun();
      setRun(null);
    } catch (err) {
      // Still running on the server: the panel stays, with the run it shows.
      setStartError(errMsg(err, "停止失败"));
    }
    await refreshConnection();
  };

  const visibleSongs = useMemo(() => {
    if (!songs) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return songs;
    const exact = songs.filter((s) => matchesQuery(s.searchText, `${s.title} ${s.artist}`, q));
    return exact.length ? exact : fuzzyRank(songs, (s) => s.searchText || `${s.title} ${s.artist}`, q);
  }, [songs, filter]);

  const visiblePlaylists = useMemo(() => {
    const q = listFilter.trim().toLowerCase();
    if (!q) return playlists;
    const exact = playlists.filter((p) => matchesQuery(p.searchText, p.name, q));
    return exact.length ? exact : fuzzyRank(playlists, (p) => p.searchText || p.name, q);
  }, [playlists, listFilter]);

  // The user changed their favourites in the platform's own app and wants the
  // page to catch up: one platform read for this list, on their say-so.
  const [refreshing, setRefreshing] = useState(false);
  const selectedRefNow = useRef(null);
  selectedRefNow.current = selected?.ref || null;
  const refreshList = async () => {
    if (!selected || refreshing) return;
    const ref = selected.ref;
    setRefreshing(true);
    setSongsError("");
    try {
      const data = await readSongs(selected, { refresh: true });
      // The user may have moved to another list while this ran (a 30s call);
      // its rows belong to the list that asked for them, not whatever is
      // selected now.
      if (selectedRefNow.current === ref) setSongs(data.songs || []);
    } catch (err) {
      if (selectedRefNow.current === ref) setSongsError(errMsg(err, "刷新失败"));
    } finally {
      setRefreshing(false);
    }
  };

  if (authLoading) return null;
  if (!user) return null;

  if (!canPlatformTag) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="mb-3 text-xl font-semibold">QQ打标</h1>
        <p className="text-sm text-muted">这个功能正在内测，暂时只对部分会员开放。</p>
      </main>
    );
  }

  const connected = ["qq", "netease"].filter((k) => sources?.[k]?.connected);

  return (
    <main className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">QQ打标</h1>
          <p className="text-xs text-muted">
            选一个你在平台上的歌单，游戏里抓到的歌和它匹配后，直接点进你平台账号的「我喜欢」。
          </p>
        </div>
        {sources && connected.length > 1 && (
          <div className="flex gap-1 rounded-md border border-border p-0.5">
            {connected.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => { setPlatform(k); setSelected(null); }}
                className={`rounded px-3 py-1 text-sm ${platform === k ? "bg-primary/10 text-primary" : "text-muted hover:text-theme"}`}
              >{PLATFORM_LABEL[k]}</button>
            ))}
          </div>
        )}
      </header>

      {sources && connected.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-6 text-sm">
          <p className="mb-2">还没连接 QQ 音乐账号。{neteaseHidden ? "（网易云打标暂不提供）" : ""}</p>
          <p className="text-muted">
            先到 <Link href="/account" className="text-primary underline">账户 → 音乐账号</Link> 扫码连接 QQ 音乐或网易云，再回到这里。
          </p>
        </div>
      )}

      {platform && sources?.[platform]?.connected && (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          {/* Playlists */}
          <aside className="rounded-xl border border-border bg-surface">
            <div className="border-b border-border px-3 py-2 text-xs text-muted">
              {PLATFORM_LABEL[platform]} · {sources[platform].nickname || "已连接"}
              {sources[platform].level === "expired" && <span className="ml-2 text-red-400">登录已过期</span>}
            </div>
            <div className="border-b border-border px-2 py-1.5">
              <input
                value={listFilter}
                onChange={(e) => setListFilter(e.target.value)}
                placeholder="搜歌单：汉字 / 拼音 / 首字母"
                className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
              />
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-1.5">
              {listLoading && <p className="p-3 text-xs text-muted">读取中…</p>}
              {listError && <p className="p-3 text-xs text-red-400">{listError}</p>}
              {!listLoading && playlists.length > 0 && visiblePlaylists.length === 0 && (
                <p className="p-3 text-xs text-muted">没有匹配的歌单</p>
              )}
              {visiblePlaylists.map((p) => {
                const active = selected?.ref === p.ref;
                const aimed = aimedRef === p.ref;
                return (
                  <button
                    key={p.ref}
                    type="button"
                    onClick={() => setSelected(p)}
                    className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                      active ? "bg-primary/10 text-primary" : "hover:bg-surface-hover"}`}
                  >
                    <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${aimed ? "bg-green-500" : "bg-transparent"}`} />
                    <span className="min-w-0 flex-1 truncate">
                      {p.isLikes ? "♥ " : ""}{p.name}
                      {p.kind === "collected" && <span className="ml-1 text-[0.65rem] text-muted">收藏</span>}
                    </span>
                    <span className="shrink-0 text-xs text-muted">{p.count ?? ""}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Selected playlist */}
          <section className="min-w-0 space-y-4">
            {!selected ? (
              <div className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-muted">
                左边选一个歌单
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-semibold">{selected.name}</h2>
                      <p className="flex items-center gap-2 text-xs text-muted">
                        <span>
                          {songs ? `${songs.length} 首` : ""}
                          {songs ? ` · 已喜欢 ${songs.filter((s) => s.alreadyLiked).length}` : ""}
                        </span>
                        <button
                          type="button"
                          onClick={refreshList}
                          disabled={refreshing || songsLoading}
                          title="在平台 App 里改了收藏后，按这里重新读取这个歌单"
                          className="rounded border border-border px-1.5 py-0.5 text-[0.65rem] text-muted hover:text-theme disabled:opacity-40"
                        >{refreshing ? "刷新中…" : "刷新"}</button>
                        {selected.ref.startsWith("qq:") && !selected.isLikes && (unliking || songs?.some((s) => s.alreadyLiked)) && (
                          <button
                            type="button"
                            onClick={() => setShowUnlikeAllConfirm(true)}
                            disabled={Boolean(unliking) || refreshing || songsLoading}
                            title="把这个歌单里的歌从 QQ「我喜欢」里全部移除（包括你原来自己点的）"
                            className="rounded border border-border px-1.5 py-0.5 text-[0.65rem] text-muted hover:text-red-400 disabled:opacity-40"
                          >{unliking ? `取消中 ${unliking.done}/${unliking.total}` : "取消全部点赞"}</button>
                        )}
                      </p>
                      {unlikeNote && <p className="mt-1 text-xs text-green-400">{unlikeNote}</p>}
                    </div>
                  </div>
                  {aimedRef && !runningHere && (
                    <p className="mt-2 text-xs text-muted">
                      连接目前投递到另一个歌单；点右下角「自动打标」会切到这个。
                    </p>
                  )}

                </div>

                <div className="rounded-xl border border-border bg-surface">
                  <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                    <input
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="搜歌名 / 歌手：汉字 / 拼音 / 首字母"
                      className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                    />
                    <span className="shrink-0 text-xs text-muted">{visibleSongs.length}</span>
                  </div>
                  {songsLoading && <p className="p-3 text-xs text-muted">读取中…</p>}
                  {songsError && <p className="p-3 text-xs text-red-400">{songsError}</p>}
                  <ul className="max-h-[60vh] divide-y divide-border/40 overflow-y-auto">
                    {visibleSongs.map((s) => (
                      <li key={s.id} className="flex items-center gap-2 px-2 py-0.5 text-sm">
                        <PlatformLikeButton
                          liked={s.alreadyLiked}
                          busy={likeBusy === s.id}
                          onToggle={() => toggleLike(s)}
                        />
                        <span className="min-w-0 flex-1 truncate" title={s.title}>{s.title}</span>
                        <span className="min-w-0 max-w-[40%] truncate text-xs text-muted" title={s.artist}>{s.artist}</span>
                        {s.vipOnly && <span className="shrink-0 text-[0.6rem] text-muted/60">VIP</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      {/* The run's floating panel (or the 自动打标 pill), as on the playlist
          page. Only on a QQ / NetEase tab with an account connected. */}
      {platform && sources?.[platform]?.connected && (
        <PlatformTagPanel
          running={runningHere}
          sessionId={connection?.sessionId || null}
          playlistRef={aimedRef}
          runStartedAt={runStartedAt}
          connection={connection}
          onLiked={markLiked}
          canStart={Boolean(selected && songs?.length && !songsLoading)}
          starting={starting}
          startError={startError}
          onStart={start}
          onStop={stop}
        />
      )}

      {showUnlikeAllConfirm && (
        <ConfirmDialog
          title="取消全部点赞"
          message="确定要取消该歌单中所有歌曲的点赞吗？"
          confirmLabel="确认"
          cancelLabel="取消"
          danger
          onConfirm={() => { setShowUnlikeAllConfirm(false); unlikeAll(); }}
          onCancel={() => setShowUnlikeAllConfirm(false)}
        />
      )}
    </main>
  );
}
