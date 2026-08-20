"use client";

/**
 * 唱卡 — live cards.
 *
 * The game puts a handful of songs on screen, the player picks one, and the
 * words appear while they sing. This page is the singer's side of that: the
 * capture client reads the titles, the server resolves each against the
 * mapping table, and every resolved song becomes a card that plays on tap.
 *
 * Opening this page is what selects live mode — the client is told by the
 * heartbeat, so there is no mode switch to forget and no way to write 唱卡
 * captures into a playlist by mistake.
 *
 * Cards are grouped into the rounds they arrived in, newest on top, because
 * that is how the game presents them: a batch goes up, one gets sung, the next
 * batch replaces it. Older rounds collapse rather than disappear — a session
 * runs for hours and the list must not become something to scroll.
 *
 * Nothing plays by itself, and only one card is ever open. A round shows
 * several songs at once and only one of them is being sung; auto-playing them
 * would mean several songs at once, out loud, during a game.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { captureAPI, mappingAPI, getLiveSSEUrl } from "@/lib/api";
import useAuth from "@/hooks/useAuth";
import useCaptureStore from "@/store/captureStore";
import useLivePlayer from "@/hooks/useLivePlayer";
import LiveLyrics from "@/components/live/LiveLyrics";
import PitchControl from "@/components/player/PitchControl";
import SpeedControl from "@/components/player/SpeedControl";

const SOURCE_LABEL = { LOCAL: "曲库", QQ: "QQ", NETEASE: "网易" };

/**
 * How long a round may stay open for new songs to join it.
 *
 * A round is opened by the picking screen and then sung through, and the three
 * modes sing different amounts of it: 唱卡 sings one of three, 极限抢唱 and
 * 两军对决 sing all of them, one performer at a time. So a round is not a
 * moment — it is a picking screen plus every performance that follows, which
 * for a five-song 两军对决 runs for minutes.
 *
 * A placeholder, and known to be one. Measured against real play, time cannot
 * recover the true grouping: gaps within a round and gaps between rounds are
 * both 25-35s and are indistinguishable. This value only keeps clearly
 * separate rounds apart (the observed between-round gap was 236s).
 *
 * The real key is which picking screen a capture came from, which the client
 * does not report yet -- the same thing the lyrics work needs, so it lands
 * with that.
 */
const ROUND_IDLE_MS = 60 * 1000;

/** Rounds kept on screen. Hours of play must not turn into endless scroll. */
const KEEP_BATCHES = 12;

// No local copy of the run is kept. The server knows whether captures are
// being recognised, and a browser-side copy only ever disagreed with it: it
// existed solely in the tab that pressed 开始识别, so every other way of
// arriving here reported "not started" while recognition was running.

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

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, Date.now() - then);
  if (diff < 60_000) return "刚刚";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} 分钟前`;
  return `${Math.floor(mins / 60)} 小时前`;
}

/**
 * Group cards into the rounds they belong to.
 *
 * Measured against real play, a fixed window could not do this: songs arrive
 * in bursts seconds apart within one picking screen, and then the performances
 * trickle in over the following minutes. A short window split one round into
 * several; a long one merged two rounds that happened to be close together.
 *
 * So the gap is measured against the last card of the round rather than its
 * first, which lets a round stay open as long as songs keep arriving and close
 * once play has moved on.
 */
function toBatches(cards) {
  const sorted = [...cards].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const batches = [];
  for (const card of sorted) {
    const at = new Date(card.createdAt).getTime();
    const last = batches[batches.length - 1];
    // `last.oldest` walks backwards as cards are added, since the list runs
    // newest-first — so this compares against the nearest card, not the first.
    if (last && last.oldest - at < ROUND_IDLE_MS) {
      last.cards.push(card);
      last.oldest = at;
    } else {
      batches.push({ at: card.createdAt, oldest: at, cards: [card] });
    }
  }
  return batches.slice(0, KEEP_BATCHES);
}

export default function LivePage() {
  const { user, isAdmin, loading: authLoading } = useAuth();
  // The connection belongs to the whole site, not this page: pressing 开始识别
  // aims it here rather than opening one, so a game already tagging a playlist
  // switches over without the client pairing again.
  const connection = useCaptureStore((s) => s.connection);
  const aim = useCaptureStore((s) => s.aim);
  const stopDelivery = useCaptureStore((s) => s.stop);
  const refreshConnection = useCaptureStore((s) => s.refresh);

  const [session, setSession] = useState(null);
  const [pairCode, setPairCode] = useState(null);
  const [cards, setCards] = useState([]);
  const [client, setClient] = useState("waiting");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [collapsed, setCollapsed] = useState({});

  // Only one card is ever open — see the header note.
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [playError, setPlayError] = useState("");
  // Playback lives in the hook: it starts an <audio> element straight away and
  // decodes in the background, so a card makes sound in well under a second
  // while pitch shifting becomes available a moment later.
  const player = useLivePlayer();
  const { isPlaying: playing, current, duration } = player;
  const [candidates, setCandidates] = useState([]);
  const [approving, setApproving] = useState(false);
  /** Set once the server refuses an approve: this account cannot edit. */
  const [canApprove, setCanApprove] = useState(true);

  const loadedFor = useRef(null);

  const batches = useMemo(() => toBatches(cards), [cards]);

  /**
   * Merge a card in by event id.
   *
   * The server dedupes, but the same card still arrives twice in one ordinary
   * case: the SSE push and the refetch that follows a reconnect. Keying by id
   * makes that harmless instead of showing the song twice.
   */
  const upsert = useCallback((card) => {
    setCards((prev) => [card, ...prev.filter((c) => c.eventId !== card.eventId)]);
  }, []);

  const loadFeed = useCallback(async (sessionId) => {
    try {
      const res = await captureAPI.liveFeed(sessionId, 60);
      setCards(res.data.cards || []);
    } catch {
      // A failed refetch is not worth a message: the stream is still live and
      // the next card will arrive on its own.
    }
  }, []);

  /**
   * Show whatever the connection is actually doing, on every visit.
   *
   * The server is the only thing that knows whether captures are being
   * recognised; this page had been asking localStorage instead, which only
   * held anything if 开始识别 had been pressed in this browser. Arriving any
   * other way — a reload, a second tab, coming back from another page — found
   * nothing stored and reported "not started" while recognition was running
   * the whole time.
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      const conn = await refreshConnection();
      if (!alive) return;
      if (!conn || conn.target !== "live") {
        setSession(null);
        return;
      }
      setSession({ id: conn.sessionId, expiresAt: conn.expiresAt });
      loadFeed(conn.sessionId);
    })();
    return () => { alive = false; };
  }, [loadFeed, refreshConnection]);

  // The stream. Reconnects are handled by EventSource itself; the refetch on
  // open is what fills in anything missed while it was down.
  useEffect(() => {
    if (!session) return undefined;
    const es = new EventSource(getLiveSSEUrl(session.id));
    es.addEventListener("open", () => loadFeed(session.id));
    es.addEventListener("live-card", (e) => {
      try {
        upsert(JSON.parse(e.data));
      } catch {
        /* a malformed frame is not worth tearing the stream down for */
      }
    });
    return () => es.close();
  }, [session, upsert, loadFeed]);

  /**
   * Poll for liveness.
   *
   * Deliberately not inferred from the SSE connection: that only proves the
   * browser can reach the server, which says nothing about whether the capture
   * client is still running.
   */
  useEffect(() => {
    if (!session) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const res = await captureAPI.status(session.id);
        if (stop) return;
        setClient(res.data.client);
        // Closed elsewhere, or aimed at something else: either way this page
        // is no longer the destination, so stop showing a live run.
        if (res.data.ended || res.data.target !== "live") {
          setSession(null);
        }
      } catch {
        /* a missed poll says nothing; the next one will answer */
      }
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => { stop = true; clearInterval(id); };
  }, [session]);

  const stopAudio = useCallback(() => {
    player.stop();
    loadedFor.current = null;
  }, [player]);

  /**
   * Resolve and play a card.
   *
   * Resolution happens on open rather than on arrival: a round shows several
   * songs and only one gets sung, so resolving all of them would spend platform
   * requests on songs nobody asked for — the pattern that gets an IP throttled.
   */
  const playCard = useCallback(async (card, override) => {
    if (!card.mapping) return;
    setPlayError("");

    const key = override
      ? `${card.eventId}:${override.source}:${override.externalId}`
      : card.eventId;

    // Same track again: pause or resume rather than reloading, so the position
    // and any decode already done survive.
    if (loadedFor.current === key) {
      await player.toggle();
      return;
    }

    setBusy(true);
    try {
      const res = await mappingAPI.preview(card.mapping.mappingId, override);
      const { url, reason, kind } = res.data;
      if (kind === "unsupported") {
        setPlayError(`${SOURCE_LABEL[card.mapping.source] || card.mapping.source} 的播放还没做`);
        return;
      }
      if (!url) {
        setPlayError(reason === "credential-expired"
          ? "音乐账号连接已失效，请到账号页重新扫码"
          : reason === "needs-vip"
            ? "这首歌需要会员"
            : "这首歌当前拿不到播放地址（可能已下架）");
        return;
      }
      loadedFor.current = key;
      await player.load(url);
    } catch (err) {
      setPlayError(err.response?.data?.error?.message || "播放失败");
    } finally {
      setBusy(false);
    }
  }, [player]);

  /** Open a card, or close the one that is open. */
  const toggleCard = useCallback(async (card) => {
    stopAudio();
    setPlayError("");
    setCandidates([]);
    if (openId === card.eventId) {
      setOpenId(null);
      return;
    }
    setOpenId(card.eventId);
    if (!card.mapping) return;

    // Alternatives came with the card when there were any; fall back to asking
    // so a card restored from the feed still offers them.
    if (card.mapping.candidates?.length) {
      setCandidates(card.mapping.candidates);
    } else {
      try {
        const res = await mappingAPI.candidates(card.mapping.mappingId);
        setCandidates(res.data.candidates || res.data || []);
      } catch {
        /* offering no alternatives is a smaller problem than an error box */
      }
    }
    playCard(card);
  }, [openId, stopAudio, playCard]);

  /** Switch to another version and play it immediately — hearing it is the test. */
  const tryCandidate = useCallback((card, cand) => {
    stopAudio();
    playCard(card, { source: cand.source, externalId: cand.externalId });
  }, [stopAudio, playCard]);

  /**
   * Confirm the mapping. Takes effect everywhere at once, which is the point:
   * the next person to meet this song gets the version just verified by ear.
   */
  const approve = useCallback(async (card, cand) => {
    if (!card.mapping) return;
    setApproving(true);
    try {
      const body = cand ? { source: cand.source, externalId: cand.externalId } : {};
      await mappingAPI.approve(card.mapping.mappingId, body);
      setCards((prev) => prev.map((c) => (
        c.eventId === card.eventId
          ? {
            ...c,
            mapping: {
              ...c.mapping,
              approved: true,
              ...(cand ? {
                source: cand.source,
                externalId: cand.externalId,
                title: cand.title,
                artist: cand.artist,
                durationSec: cand.durationSec,
              } : {}),
            },
          }
          : c
      )));
    } catch (err) {
      // A 403 means this account simply lacks the flag. Say so once and stop
      // offering the button rather than failing every time it is pressed.
      if (err.response?.status === 403) setCanApprove(false);
      else setPlayError(err.response?.data?.error?.message || "确认失败");
    } finally {
      setApproving(false);
    }
  }, []);

  const start = useCallback(async () => {
    setError("");
    setStarting(true);
    try {
      const ok = await aim("live");
      if (!ok) {
        setError(useCaptureStore.getState().error || "无法开始，请稍后再试");
        return;
      }
      const conn = useCaptureStore.getState().connection;
      const s = { id: conn.sessionId, expiresAt: conn.expiresAt };
      setSession(s);
      setPairCode(conn.pairCode || null);
      setCards([]);
    } catch (err) {
      setError(err.response?.data?.error?.message || "无法开始，请稍后再试");
    } finally {
      setStarting(false);
    }
  }, [aim]);

  const stop = useCallback(async () => {
    if (!session) return;
    // Stops delivery, not the connection: the client stays paired so the next
    // round -- here or in a playlist -- costs nothing to start.
    await stopDelivery();
    stopAudio();
    setOpenId(null);
    setSession(null);
    setPairCode(null);
    setCards([]);
  }, [session, stopAudio, stopDelivery]);

  // Teardown lives in the hook, which also has to close the AudioContext.

  if (authLoading) return null;

  if (!user) {
    return <div className="mx-auto max-w-2xl px-4 py-16 text-center text-muted">请先登录。</div>;
  }

  // Admins only while this is being proven out. The nav link is hidden the same
  // way, but the URL is guessable and the add-on that would otherwise open this
  // was sold for auto-tagging -- its holders have a client that cannot read the
  // 唱卡 screens, so they would reach a page that never receives anything.
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <h1 className="mb-2 text-lg font-medium">唱卡</h1>
        <p className="text-sm text-muted">唱卡还在内测中，暂未开放。</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">唱卡</h1>
          <p className="text-xs text-muted">游戏里出现的歌会自动出现在这里，点开即可播放。</p>
        </div>
        {session ? (
          <button
            type="button"
            onClick={stop}
            className="shrink-0 rounded border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
          >
            结束
          </button>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={starting}
            className="shrink-0 rounded bg-accent px-4 py-1.5 text-sm font-medium text-black disabled:opacity-40"
          >
            {starting ? "…" : "开始"}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* The code is the whole point of the empty state: until it is typed into
          the client, nothing can arrive and the page would just look broken. */}
      {session && pairCode && client !== "connected" && (
        <div className="mb-4 rounded border border-border bg-surface px-4 py-3">
          <div className="text-xs text-muted">在手机客户端里输入配对码</div>
          <div className="mt-1 font-mono text-2xl tracking-widest">{pairCode}</div>
        </div>
      )}

      {session && (
        <div className="mb-3 flex items-center gap-2 text-xs text-muted">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              client === "connected" ? "bg-green-500"
                : client === "stale" ? "bg-yellow-500" : "bg-white/30"
            }`}
          />
          {client === "connected" ? "已连接 · 唱卡识别中"
            : client === "stale" ? "客户端无响应" : "等待客户端连接"}
        </div>
      )}

      {!session ? (
        <div className="rounded border border-border bg-surface px-4 py-10 text-center text-sm text-muted">
          点「开始」后，在客户端里输入配对码即可。
        </div>
      ) : !batches.length ? (
        <div className="rounded border border-border bg-surface px-4 py-10 text-center text-sm text-muted">
          还没有捕捉到歌曲。
        </div>
      ) : (
        <div className="space-y-3">
          {batches.map((batch, bi) => {
            // Older rounds fold away by default: the current one is what is
            // being sung, and the rest are there to fall back on.
            const isCollapsed = collapsed[batch.at] ?? bi > 0;
            return (
              <section key={batch.at} className="rounded-lg border border-border bg-surface">
                <button
                  type="button"
                  onClick={() => setCollapsed((p) => ({ ...p, [batch.at]: !isCollapsed }))}
                  className="flex w-full items-center justify-between px-3 py-2 text-left"
                >
                  <span className="text-xs text-muted">
                    第 {batches.length - bi} 批 · {relativeTime(batch.at)} · {batch.cards.length} 首
                  </span>
                  <span className="text-xs text-muted">{isCollapsed ? "▾" : "▴"}</span>
                </button>

                {!isCollapsed && (
                  <ul className="border-t border-border/60">
                    {batch.cards.map((card) => {
                      const mapped = Boolean(card.mapping);
                      const isOpen = openId === card.eventId;
                      const confirmed = card.mapping?.approved;
                      return (
                        <li key={card.eventId} className="border-b border-border/40 last:border-b-0">
                          <button
                            type="button"
                            onClick={() => toggleCard(card)}
                            disabled={!mapped}
                            className="flex w-full items-center gap-3 px-3 py-2.5 text-left disabled:opacity-60"
                          >
                            <span className="h-8 w-8 shrink-0 rounded-full border border-border text-center text-xs leading-8">
                              {!mapped ? "—" : busy && isOpen ? "…" : isOpen && playing ? "❚❚" : "▶"}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{card.title}</span>
                              <span className="block truncate text-xs text-muted">
                                {card.artist || "（无歌手）"}
                                {mapped && (
                                  <>
                                    {" · "}
                                    {SOURCE_LABEL[card.mapping.source] || card.mapping.source}
                                    {" · "}{formatDuration(card.mapping.durationSec)}
                                  </>
                                )}
                              </span>
                            </span>
                            {/* An unmapped song is the ordinary way a gap shows
                                up, and an unconfirmed one still plays — both say
                                what they are rather than looking like failures. */}
                            {!mapped ? (
                              <span className="shrink-0 rounded bg-black/20 px-2 py-0.5 text-[0.65rem] text-muted">
                                未配置
                              </span>
                            ) : !confirmed ? (
                              <span className="shrink-0 rounded bg-yellow-500/15 px-2 py-0.5 text-[0.65rem] text-yellow-500">
                                待确认
                              </span>
                            ) : (
                              /* Said outright rather than left blank. An
                                 unlabelled card is indistinguishable from one
                                 whose status has not loaded, and "this is the
                                 right recording" is the thing a singer wants
                                 to know before trusting it mid-game. */
                              <span className="shrink-0 rounded bg-green-500/15 px-2 py-0.5 text-[0.65rem] text-green-500">
                                已确认
                              </span>
                            )}
                          </button>

                          {isOpen && mapped && (
                            <div className="border-t border-border/40 bg-black/10 px-3 py-3">
                              {playError && (
                                <div className="mb-2 text-xs text-red-400">{playError}</div>
                              )}

                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => playCard(card)}
                                  disabled={busy}
                                  className="h-8 w-8 shrink-0 rounded-full border border-border text-xs hover:border-accent disabled:opacity-30"
                                >
                                  {busy ? "…" : playing ? "❚❚" : "▶"}
                                </button>
                                <div
                                  role="presentation"
                                  onClick={(e) => {
                                    const r = e.currentTarget.getBoundingClientRect();
                                    if (duration > 0) {
                                      player.seek(((e.clientX - r.left) / r.width) * duration);
                                    }
                                  }}
                                  className="h-1.5 flex-1 cursor-pointer rounded-full bg-black/30"
                                >
                                  <div
                                    className="h-full rounded-full bg-accent"
                                    style={{
                                      width: `${duration > 0
                                        ? Math.min(100, (current / duration) * 100)
                                        : 0}%`,
                                    }}
                                  />
                                </div>
                                <span className="shrink-0 font-mono text-[0.68rem] text-muted">
                                  {formatClock(current)} / {formatClock(duration)}
                                </span>
                              </div>

                              {/* Pitch and tempo. Pitch appears only once the
                                  track is decoded, which is a second or two
                                  behind the first sound -- offering a control
                                  that silently does nothing would be worse
                                  than making it arrive late. */}
                              <div className="mt-2 flex items-center gap-3">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[0.65rem] text-muted">变调</span>
                                  {player.canShift ? (
                                    <PitchControl pitch={player.pitch} onChange={player.setPitch} />
                                  ) : (
                                    <span className="text-[0.65rem] text-muted/60">准备中…</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[0.65rem] text-muted">速度</span>
                                  <SpeedControl speed={player.speed} onChange={player.setSpeed} />
                                </div>
                              </div>

                              {/* The words. The game's own passage is picked
                                  out inside the real lyrics, so the singer can
                                  see what is coming and jump straight to it. */}
                              <div className="mt-2 border-t border-border/40 pt-1">
                                <LiveLyrics
                                  mappingId={card.mapping.mappingId}
                                  gameLyric={card.lyric}
                                  current={current}
                                  onSeek={player.seek}
                                />
                              </div>

                              <div className="mt-2 truncate text-xs text-muted">
                                当前：{card.mapping.title || card.title}
                                {card.mapping.artist ? ` · ${card.mapping.artist}` : ""}
                                {" · "}{SOURCE_LABEL[card.mapping.source] || card.mapping.source}
                              </div>

                              {canApprove && !confirmed && (
                                <button
                                  type="button"
                                  onClick={() => approve(card)}
                                  disabled={approving}
                                  className="mt-2 rounded border border-accent px-2 py-1 text-xs text-accent disabled:opacity-40"
                                >
                                  {approving ? "…" : "✓ 就是这个"}
                                </button>
                              )}

                              {candidates.length > 1 && (
                                <div className="mt-3 border-t border-border/40 pt-2">
                                  <div className="mb-1 text-[0.68rem] text-muted">其他版本</div>
                                  <ul className="space-y-1">
                                    {candidates
                                      .filter((c) => c.externalId !== card.mapping.externalId)
                                      .slice(0, 5)
                                      .map((c) => (
                                        <li key={`${c.source}:${c.externalId}`} className="flex items-center gap-2">
                                          <button
                                            type="button"
                                            onClick={() => tryCandidate(card, c)}
                                            className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-xs text-muted hover:bg-white/5 hover:text-fg"
                                          >
                                            {c.title} · {c.artist} · {formatDuration(c.durationSec)}
                                            {" · "}{SOURCE_LABEL[c.source] || c.source}
                                          </button>
                                          {canApprove && (
                                            <button
                                              type="button"
                                              onClick={() => approve(card, c)}
                                              disabled={approving}
                                              className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[0.65rem] text-muted hover:border-accent hover:text-fg disabled:opacity-40"
                                            >
                                              选它
                                            </button>
                                          )}
                                        </li>
                                      ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
