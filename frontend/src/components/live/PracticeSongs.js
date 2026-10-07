"use client";

/**
 * 练唱 — sing any song the library knows, without a game.
 *
 * Search as 标记 does (the same /capture/library rows: songs 唱卡 has met and
 * someone confirmed), and every result opens and plays as a 唱卡 card does:
 * the words, the transport, the key and tempo, the singer's marks.
 *
 * Its own copy of the card rather than the 唱卡 page's, on purpose: that page
 * is one component wrapped around a running game, and every piece of it reads
 * the game's card list. Reaching into it would put this tab's changes into the
 * game's path. What is left out is what only a game has: the passage the game
 * is showing (yellow dots, 段落点准确/不准确) and the 就是这个 confirmation --
 * every row here is already confirmed.
 *
 * Who fetches a QQ play URL is the same as 唱卡 (档位设置, qqDirect): in 用户 IP
 * mode it is this browser, never the server. 唱卡 hears the mode on a running
 * game's status poll; with no game here, it comes from /capture/practice, and
 * nothing plays until it has -- a tap before then would have gone to the
 * server. 网易 is resolved by the server, exactly as on a 唱卡 card; 独家 plays
 * from our own files.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import api, { captureAPI, mappingAPI, getStreamUrl } from "@/lib/api";
import useLivePlayer from "@/hooks/useLivePlayer";
import LiveLyrics from "@/components/live/LiveLyrics";
import LivePitchControl from "@/components/live/LivePitchControl";
import LiveSpeedControl from "@/components/live/LiveSpeedControl";
import SongPrefEditor, { SongPrefMarks } from "@/components/live/SongPrefTags";
import { PRESET_COLORS } from "@/components/player/ColorTag";
import DefaultTuning from "@/components/live/DefaultTuning";
import {
  loadStoredQuality, storeQuality, loadStoredVocals, storeVocals, QUALITY_TIERS,
} from "@/components/live/LiveVolumeControl";
import { PlayIcon, PauseIcon, BusyIcon } from "@/components/live/TransportIcons";
import * as qqDirect from "@/lib/qqDirect";

const PAGE = 40;
const SOURCE_LABEL = { LOCAL: "独家", QQ: "QQ", NETEASE: "网易" };
// Same cadence as 唱卡's status poll, so a change in 档位设置 reaches this tab
// as quickly as it reaches a game.
const CONTEXT_POLL_MS = 15000;

function formatDuration(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  return formatDuration(Math.floor(sec));
}

/** A library row in the shape a 唱卡 card has. */
function toCard(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    mapping: {
      mappingId: row.id,
      source: row.source,
      externalId: row.externalId,
      durationSec: row.durationSec,
      title: row.platformTitle,
      artist: row.platformArtist,
    },
  };
}

export default function PracticeSongs({ onPrefChange, onDefaultsChange, onQualityChange, onVocalsChange }) {
  // --- Search (as 标记) -----------------------------------------------------
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const runRef = useRef(0);

  // --- What the first song needs: the QQ mode and the default key/tempo ------
  const [ready, setReady] = useState(false);
  const [contextError, setContextError] = useState(false);
  const [defaults, setDefaults] = useState(null);

  const [prefs, setPrefs] = useState({});
  const prefKey = useCallback(
    (mapping) => (mapping ? `${mapping.source}:${mapping.externalId}` : null),
    []
  );

  // --- The open card and its player ------------------------------------------
  const [openCard, setOpenCard] = useState(null);
  const openId = openCard?.id || null;
  const [busy, setBusy] = useState(false);
  const [playError, setPlayError] = useState("");
  const player = useLivePlayer();
  const { isPlaying: playing, current, duration } = player;

  const [quality, setQualityState] = useState("mp3_128");
  const [vocalsOnly, setVocalsOnlyState] = useState(false);
  const [vocalsAvailable, setVocalsAvailable] = useState(null);
  useEffect(() => {
    setQualityState(loadStoredQuality());
    setVocalsOnlyState(loadStoredVocals());
  }, []);

  // False once this tab has gone. A play still on its way then (QQ answering,
  // a file loading) must not start: nothing would be left to stop it.
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const touchedRef = useRef(false);
  const openCardRef = useRef(null);
  const settingsRef = useRef({ pitch: 0, speed: 1 });
  settingsRef.current = { pitch: player.pitch, speed: player.speed };
  const loadedFor = useRef(null);
  const lineTimes = useRef([]);
  const setLineTimes = useCallback((times) => { lineTimes.current = times || []; }, []);
  const [chorusTime, setChorusTime] = useState(null);
  const onChorusTime = useCallback((t) => {
    setChorusTime((prev) => (prev === t ? prev : t));
  }, []);
  // No game passage here: LiveLyrics reports none, and nothing is drawn for it.
  const noop = useCallback(() => {}, []);

  // --- Context ---------------------------------------------------------------
  const contextNowRef = useRef(() => {});
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await api.get("/capture/practice");
        if (!alive) return;
        qqDirect.noteMode(res.data.qqDirectMode);
        // The first answer seeds the defaults; later ones would overwrite a
        // change this tab just made with a read that raced it.
        setDefaults((prev) => (prev === null ? (res.data.defaults || { pitch: null, speed: null }) : prev));
        setReady(true);
        setContextError(false);
      } catch {
        if (alive) setContextError(true);
      } finally {
        inFlight = false;
      }
    };
    contextNowRef.current = tick;
    tick();
    // Not while the page is hidden; asked again the moment it is back.
    const id = setInterval(() => { if (!document.hidden) tick(); }, CONTEXT_POLL_MS);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // --- Search ----------------------------------------------------------------
  const load = useCallback(async (query, after = null) => {
    const run = ++runRef.current;
    setLoading(true);
    setError("");
    try {
      const res = await captureAPI.library({ q: query, cursor: after, take: PAGE });
      if (run !== runRef.current) return;
      const got = res.data.rows || [];
      setRows((prev) => (after ? [...prev, ...got] : got));
      setCursor(res.data.nextCursor);
      setSearched(true);
      // Each row carries this singer's marks for it, read with the search.
      setPrefs((prev) => {
        const next = { ...prev };
        for (const r of got) next[`${r.source}:${r.externalId}`] = r.prefs || next[`${r.source}:${r.externalId}`] || null;
        return next;
      });
    } catch (err) {
      if (run !== runRef.current) return;
      setError(err.response?.data?.error?.message || "搜索失败");
    } finally {
      if (run === runRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      runRef.current += 1;
      setRows([]); setCursor(null); setSearched(false); setLoading(false);
      return undefined;
    }
    const t = setTimeout(() => load(term), 300);
    return () => clearTimeout(t);
  }, [q, load]);

  // --- Saving what the singer settled on (as 唱卡) -----------------------------
  // The 唱卡 tab is told too (outside the state update: it is another
  // component's state), so a song marked here is marked there.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const notePref = useCallback((key, patch) => {
    const merged = { ...(prefsRef.current[key] || {}), ...patch };
    prefsRef.current = { ...prefsRef.current, [key]: merged };
    setPrefs((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ...patch } }));
    onPrefChange?.(key, merged);
  }, [onPrefChange]);

  const saveOpenCardSettings = useCallback(() => {
    const card = openCardRef.current;
    openCardRef.current = null;
    if (!touchedRef.current) return;
    touchedRef.current = false;
    if (!card || !card.mapping) return;
    const key = prefKey(card.mapping);
    const { pitch, speed } = settingsRef.current;
    notePref(key, { pitch, speed });
    captureAPI
      .saveSongPref(card.mapping.source, card.mapping.externalId, { pitch, speed })
      .catch(() => { /* retried the next time the card closes */ });
  }, [prefKey, notePref]);

  const saveRef = useRef(saveOpenCardSettings);
  saveRef.current = saveOpenCardSettings;
  useEffect(() => () => saveRef.current(), []);

  const stopAudio = useCallback(() => {
    player.stop();
    loadedFor.current = null;
  }, [player]);

  const fallbackNotice = useCallback((data, asked) => {
    if (!data?.fellBack) return "";
    const name = (id) => QUALITY_TIERS.find((t) => t.id === id)?.label || id;
    if (asked.vocalsOnly && !data.vocalsPlayed) {
      return `这首歌没有纯人声，已用${name(data.playedTier)}音质播放`;
    }
    if (data.playedTier && data.playedTier !== asked.tier) {
      return `这首歌没有${name(asked.tier)}，已用${name(data.playedTier)}播放`;
    }
    return "";
  }, []);

  // --- Playing (as 唱卡's playCard) ---------------------------------------------
  const playCard = useCallback(async (card) => {
    if (!card.mapping) return;
    player.unlockAudio();
    setPlayError("");
    // Until the mode is known a QQ tap would go to the server: refused here,
    // and the button says why.
    if (!ready) {
      if (contextError) contextNowRef.current();
      setPlayError(contextError ? "连接失败，请稍后再点" : "正在准备，请稍后再点");
      return;
    }
    setVocalsAvailable(null);
    const key = card.id;
    if (loadedFor.current === key) {
      await player.toggle();
      return;
    }
    const priming = qqDirect.primeWanted() ? player.primeElement() : null;
    setBusy(true);
    // The tab has gone (stop whatever may have started), or this card was
    // closed or replaced while its answer was on the way (start nothing).
    const abandoned = () => {
      if (!aliveRef.current) { player.stop(); return true; }
      return openCardRef.current?.id !== key;
    };
    try {
      const prime = priming ? await priming : null;
      let res = await qqDirect.resolve(card.mapping, { tier: quality, vocalsOnly }, () => (
        mappingAPI.preview(card.mapping.mappingId, undefined, { tier: quality, vocalsOnly })
      ), { elementHasPlayed: player.elementHasPlayed(), prime });
      if (abandoned()) return;
      const { url, reason, kind, songId } = res.data;
      if (kind === "unsupported") {
        setPlayError(`${SOURCE_LABEL[card.mapping.source] || card.mapping.source} 的播放还没做`);
        return;
      }
      if (kind === "local" && songId) {
        loadedFor.current = key;
        await player.load(getStreamUrl(songId));
        abandoned();
        return;
      }
      if (!url) {
        setPlayError(reason === "credential-expired"
          ? "音乐账号连接已失效，请到账号页重新扫码"
          : reason === "needs-login"
            ? "这首歌需要会员，或音乐账号连接已失效，请到账号页重新扫码"
            : reason === "needs-vip"
              ? "这首歌需要会员"
              : "这首歌当前拿不到播放地址（可能已下架）");
        return;
      }
      loadedFor.current = key;
      const DIRECT_START_LIMIT_MS = 15000;
      try {
        if (res.onPlayFail) await qqDirect.withStartLimit(player.load(url), DIRECT_START_LIMIT_MS);
        else await player.load(url);
      } catch (loadErr) {
        if (loadErr?.name === "StartTimeout") player.stop();
        if (loadErr?.name !== "AbortError" && loadedFor.current === key) loadedFor.current = null;
        const refused = loadErr?.name === "NotAllowedError";
        if (!res.onPlayFail || loadErr?.name === "AbortError") throw loadErr;
        // A URL QQ gave this browser that will not play: asked of QQ once
        // more when it was an older cached one -- never of the server.
        res = await res.onPlayFail(
          refused ? "notallowed" : loadErr?.name === "StartTimeout" ? "timeout" : "error",
          player.mediaErrorCode(),
        );
        if (abandoned()) return;
        if (loadedFor.current !== null && loadedFor.current !== key) return;
        if (!res.data?.url) throw loadErr;
        loadedFor.current = key;
        await player.load(res.data.url);
      }
      if (abandoned()) return;
      await player.setVocalsOnly(res.data.vocalsPlayed === true);
      const note = fallbackNotice(res.data, { tier: quality, vocalsOnly });
      if (note) setPlayError(note);
      res.afterPlay?.(player.bufferReady);
    } catch (err) {
      setPlayError(err.response?.data?.error?.message || "播放失败");
    } finally {
      setBusy(false);
    }
  }, [player, quality, vocalsOnly, ready, contextError, fallbackNotice]);

  // Put the open card into its key and tempo: its own, else the default, else
  // the original (as 唱卡).
  const appliedFor = useRef(null);
  useEffect(() => {
    if (!openCard) { appliedFor.current = null; return; }
    // Not before the singer's defaults are known: applied now, the original
    // tempo would stick and the default never follow.
    if (defaults === null) return;
    const saved = prefs[prefKey(openCard.mapping)] || {};
    const wantSpeed = typeof saved.speed === "number" ? saved.speed
      : (typeof defaults?.speed === "number" ? defaults.speed : 1);
    const wantPitch = typeof saved.pitch === "number" ? saved.pitch
      : (typeof defaults?.pitch === "number" ? defaults.pitch : 0);
    const id = openCard.id;
    if (appliedFor.current !== `${id}:speed` && appliedFor.current !== `${id}:both`) {
      if (wantSpeed !== player.speed) player.setSpeed(wantSpeed);
      appliedFor.current = `${id}:speed`;
    }
    if (player.canShift && appliedFor.current !== `${id}:both`) {
      if (wantPitch !== player.pitch) player.setPitch(wantPitch);
      appliedFor.current = `${id}:both`;
    }
  }, [openCard, prefs, defaults, prefKey, player.canShift, player.speed,
    player.pitch, player.setSpeed, player.setPitch]);

  const { setPitch: playerSetPitch, setSpeed: playerSetSpeed } = player;
  const changePitch = useCallback((value) => {
    touchedRef.current = true;
    playerSetPitch(value);
  }, [playerSetPitch]);
  const changeSpeed = useCallback((value) => {
    touchedRef.current = true;
    playerSetSpeed(value);
  }, [playerSetSpeed]);

  const changeDefaults = useCallback((patch) => {
    const nextDefaults = { pitch: null, speed: null, ...(defaults || {}), ...patch };
    setDefaults(nextDefaults);
    onDefaultsChange?.(nextDefaults);
    captureAPI.saveSongPrefDefaults(patch).catch(() => { /* the next change retries it */ });
    if (typeof patch.speed === "number") playerSetSpeed(patch.speed);
    if (typeof patch.pitch === "number" && player.canShift) playerSetPitch(patch.pitch);

    const card = openCard;
    if (!card || !card.mapping) return;
    const key = prefKey(card.mapping);
    const own = prefs[key];
    if (!own) return;
    const update = {};
    if (patch.pitch !== undefined && typeof own.pitch === "number") update.pitch = patch.pitch;
    if (patch.speed !== undefined && typeof own.speed === "number") update.speed = patch.speed;
    if (!Object.keys(update).length) return;
    notePref(key, update);
    captureAPI
      .saveSongPref(card.mapping.source, card.mapping.externalId, update)
      .catch(() => { /* as above */ });
  }, [openCard, prefs, defaults, prefKey, playerSetSpeed, playerSetPitch, player.canShift, onDefaultsChange, notePref]);

  // Quality and 只听人声 switch the file under a song that is playing (as 唱卡).
  const applyPlaybackSetting = useCallback(async (next) => {
    const card = openCard;
    if (!card?.mapping || !playing) return;
    const priming = qqDirect.primeWanted() ? player.primeSpare() : null;
    const gone = () => {
      if (!aliveRef.current) { player.stop(); return true; }
      return loadedFor.current !== card.id;
    };
    try {
      const prime = priming ? await priming : null;
      let res = await qqDirect.resolve(card.mapping, next, () => (
        mappingAPI.preview(card.mapping.mappingId, undefined, next)
      ), { elementHasPlayed: prime === "ok" || prime === "already", prime });
      if (gone()) return;
      const { url, kind, songId } = res.data;
      if (kind === "local" && songId) return;
      if (!url) {
        setPlayError("这首歌暂时播放不了");
        return;
      }
      if (next.vocalsOnly) setVocalsAvailable(res.data.vocalsPlayed === true);
      const swapped = await player.swapSource(url);
      if (gone()) return;
      if (swapped === false && res.onPlayFail) {
        res = await res.onPlayFail("timeout");
        if (gone()) return;
        if (!res.data?.url) {
          setPlayError("这首歌暂时播放不了");
          return;
        }
        if (next.vocalsOnly) setVocalsAvailable(res.data.vocalsPlayed === true);
        await player.swapSource(res.data.url);
        if (gone()) return;
      }
      await player.setVocalsOnly(res.data.vocalsPlayed === true);
      const note = fallbackNotice(res.data, next);
      if (note) setPlayError(note);
      res.afterPlay?.(player.bufferReady);
    } catch (err) {
      setPlayError(err.response?.data?.error?.message || "切换失败");
    }
  }, [openCard, playing, player, fallbackNotice]);

  const changeQuality = useCallback((tier) => {
    setQualityState(tier);
    storeQuality(tier);
    onQualityChange?.(tier);
    applyPlaybackSetting({ tier, vocalsOnly });
  }, [vocalsOnly, applyPlaybackSetting, onQualityChange]);

  const changeVocalsOnly = useCallback((on) => {
    setVocalsOnlyState(on);
    storeVocals(on);
    onVocalsChange?.(on);
    applyPlaybackSetting({ tier: quality, vocalsOnly: on });
  }, [quality, applyPlaybackSetting, onVocalsChange]);

  const changeMarks = useCallback((card, patch) => {
    if (!card.mapping) return;
    notePref(prefKey(card.mapping), patch);
    captureAPI
      .saveSongPref(card.mapping.source, card.mapping.externalId, patch)
      .catch(() => { /* see saveOpenCardSettings */ });
  }, [prefKey, notePref]);

  /** Open a card, or close the one that is open (as 唱卡). */
  const toggleCard = useCallback((card) => {
    saveOpenCardSettings();
    stopAudio();
    setPlayError("");
    setLineTimes([]);
    setChorusTime(null);
    if (openId === card.id) {
      setOpenCard(null);
      return;
    }
    setOpenCard(card);
    openCardRef.current = card;
    playCard(card);
  }, [openId, stopAudio, playCard, setLineTimes, saveOpenCardSettings]);

  const togglePlayback = useCallback((card) => playCard(card), [playCard]);

  // Space, ←/→ (a/d) a second, w/s a lyric line -- as 唱卡, never while typing.
  useEffect(() => {
    if (!openCard) return undefined;
    const onKey = (e) => {
      const el = e.target;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
        || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const jumpLine = (dir) => {
        const times = lineTimes.current;
        if (!times.length) return;
        const now = player.current;
        if (dir < 0) {
          const target = now - 0.35;
          let i = -1;
          for (let k = 0; k < times.length; k++) if (times[k] <= target) i = k;
          player.seek(Math.max(0, i >= 0 ? times[i] : 0));
        } else {
          const next = times.find((t) => t > now + 0.05);
          if (next != null) player.seek(next);
        }
      };
      if (e.key === " ") {
        e.preventDefault();
        togglePlayback(openCard);
      } else if (e.key === "ArrowLeft" || key === "a") {
        e.preventDefault();
        player.seek(Math.max(0, player.current - 1));
      } else if (e.key === "ArrowRight" || key === "d") {
        e.preventDefault();
        const d = player.duration;
        player.seek(d > 0 ? Math.min(d, player.current + 1) : player.current + 1);
      } else if (key === "w") {
        e.preventDefault();
        jumpLine(-1);
      } else if (key === "s") {
        e.preventDefault();
        jumpLine(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCard, togglePlayback, player]);

  // A new search keeps the song being sung on screen, at the top, rather than
  // cutting it off mid-line.
  const cards = rows.map(toCard);
  const shown = openCard && !cards.some((c) => c.id === openCard.id) ? [openCard, ...cards] : cards;

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索歌名或歌手"
        className="mb-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
      />

      {error ? <p className="mb-2 text-xs text-red-400">{error}</p> : null}

      {!searched && !loading && !openCard ? (
        <div className="rounded-xl border border-border bg-surface p-6 text-sm text-muted">
          搜索歌名或歌手，点开就能唱。
        </div>
      ) : null}

      {searched && !rows.length && !loading ? (
        <div className="mb-2 rounded-xl border border-border bg-surface p-6 text-sm text-muted">
          没有匹配的结果。只有被Q你一下目前为止识别到过的唱卡才会出现在这里，请过段时间再来试试吧。
        </div>
      ) : null}

      {shown.length ? (
        <ul className="rounded-lg border border-border bg-surface">
          {shown.map((card) => {
            const isOpen = openId === card.id;
            const cardPrefs = prefs[prefKey(card.mapping)];
            return (
              <li key={card.id} className="border-b border-border/40 last:border-b-0">
                <button
                  type="button"
                  onClick={() => toggleCard(card)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border">
                    {busy && isOpen ? <BusyIcon />
                      : isOpen && playing ? <PauseIcon /> : <PlayIcon />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{card.title}</span>
                    <span className="block truncate text-xs text-muted">
                      {card.artist || "（无歌手）"}
                      {" · "}
                      {SOURCE_LABEL[card.mapping.source] || card.mapping.source}
                      {" · "}{formatDuration(card.mapping.durationSec)}
                    </span>
                    {cardPrefs?.note || cardPrefs?.colorTag ? (
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 sm:hidden">
                        <SongPrefMarks prefs={cardPrefs} />
                      </span>
                    ) : null}
                  </span>
                  <span className="hidden sm:contents">
                    <SongPrefMarks prefs={cardPrefs} />
                  </span>
                  {/* Every row here is a confirmed mapping (the library holds
                      no others), so the badge is always this one. */}
                  <span className="shrink-0 rounded bg-green-500/15 px-2 py-0.5 text-[0.65rem] text-green-500">
                    已确认
                  </span>
                </button>

                {isOpen && (
                  <div className="border-t border-border/40 bg-black/5 px-3 py-3 dark:bg-black/10">
                    {playError && (
                      <div className="mb-2 text-xs text-red-400">{playError}</div>
                    )}

                    <div className="border-t border-border/40 pt-1">
                      <LiveLyrics
                        mappingId={card.mapping.mappingId}
                        gameLyric={null}
                        current={current}
                        onSeek={player.seek}
                        onTimesChange={setLineTimes}
                        onPassageTimes={noop}
                        onChorusTime={onChorusTime}
                        onPlaces={noop}
                        onUsedVerified={noop}
                      />
                    </div>

                    <div className="mt-2 flex items-center gap-2">
                      <div
                        role="presentation"
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          if (duration <= 0 || r.width <= 0) return;
                          const clickTime = ((e.clientX - r.left) / r.width) * duration;
                          // Snap to the chorus dot when the click lands near
                          // it -- the only marker drawn here (as 唱卡).
                          const SNAP_PX = 24;
                          let target = clickTime;
                          if (chorusTime !== null
                            && Math.abs(chorusTime - clickTime) <= (SNAP_PX / r.width) * duration) {
                            target = chorusTime;
                          }
                          player.seek(Math.max(0, target));
                        }}
                        className="group relative h-1.5 flex-1 cursor-pointer rounded-full bg-black/30"
                      >
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{
                            width: `${duration > 0
                              ? Math.min(100, (current / duration) * 100)
                              : 0}%`,
                          }}
                        />
                        {duration > 0 && chorusTime !== null && (
                          <div
                            aria-hidden="true"
                            className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background"
                            style={{
                              left: `${Math.min(100, (chorusTime / duration) * 100)}%`,
                              backgroundColor: PRESET_COLORS[2],
                            }}
                          />
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-[0.68rem] text-muted">
                        {formatClock(current)} / {formatClock(duration)}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => togglePlayback(card)}
                        disabled={busy}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border hover:border-accent disabled:opacity-30"
                        aria-label={playing ? "暂停" : "播放"}
                      >
                        {busy ? <BusyIcon /> : playing ? <PauseIcon /> : <PlayIcon />}
                      </button>
                      <button
                        type="button"
                        onClick={() => player.seek(Math.max(0, current - 1))}
                        disabled={!playing && current === 0}
                        className="shrink-0 rounded border border-border px-2 py-1 font-mono text-[0.68rem] text-muted hover:border-accent hover:text-theme disabled:opacity-30"
                        title="后退 1 秒（←）"
                      >
                        −1s
                      </button>
                      <button
                        type="button"
                        onClick={() => player.seek(
                          duration > 0 ? Math.min(duration, current + 1) : current + 1
                        )}
                        disabled={!playing && current === 0}
                        className="shrink-0 rounded border border-border px-2 py-1 font-mono text-[0.68rem] text-muted hover:border-accent hover:text-theme disabled:opacity-30"
                        title="前进 1 秒（→）"
                      >
                        +1s
                      </button>

                      <div className="ml-auto flex flex-col items-end gap-1">
                        <div className="flex items-center gap-1.5">
                          <span className="w-7 shrink-0 text-right text-[0.62rem] text-muted">变调</span>
                          {player.canShift ? (
                            <LivePitchControl pitch={player.pitch} onChange={changePitch} />
                          ) : (
                            <span className="flex h-6 items-center text-[0.65rem] text-muted/60">
                              准备中…
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-7 shrink-0 text-right text-[0.62rem] text-muted">变速</span>
                          <LiveSpeedControl speed={player.speed} onChange={changeSpeed} />
                        </div>
                      </div>
                    </div>

                    <div className="mt-2 truncate text-xs text-muted">
                      当前：{card.mapping.title || card.title}
                      {card.mapping.artist ? ` · ${card.mapping.artist}` : ""}
                      {" · "}{SOURCE_LABEL[card.mapping.source] || card.mapping.source}
                    </div>

                    <SongPrefEditor
                      prefs={cardPrefs}
                      onChange={(patch) => changeMarks(card, patch)}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

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

      <DefaultTuning
        defaults={defaults}
        onChange={changeDefaults}
        disabled={defaults === null}
        volume={player.volume}
        onVolumeChange={player.setVolume}
        quality={quality}
        onQualityChange={changeQuality}
        vocalsOnly={vocalsOnly}
        onVocalsChange={changeVocalsOnly}
        vocalsAvailable={vocalsAvailable}
      />
    </div>
  );
}
