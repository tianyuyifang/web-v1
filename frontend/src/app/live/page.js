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
 * captures into a playlist by mistake (decisions 10 and 13).
 *
 * Nothing plays by itself. A card is resolved, not started: audio begins only
 * when it is tapped, because a round puts several songs up at once and only
 * one of them is being sung.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { captureAPI, mappingAPI, getLiveSSEUrl } from "@/lib/api";
import useAuth from "@/hooks/useAuth";

const SOURCE_LABEL = { LOCAL: "曲库", QQ: "QQ", NETEASE: "网易" };

/**
 * How many cards stay on screen.
 *
 * A round holds a handful and they are sung one at a time, so the useful
 * window is "this round and the one before it" — enough to still see a song
 * that was picked a moment ago, short enough that the list never becomes
 * something to scroll through mid-game.
 */
const KEEP_CARDS = 12;

/** Survives a reload, so a refresh mid-round does not end the run. */
const SESSION_KEY = "capture-session:live";

function remember(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // private mode or a full quota; losing this only costs the restore
  }
}

function recall() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.id) return null;
    // An expired run cannot be resumed — dropping it here means the page opens
    // ready to start rather than showing a session that is already dead.
    if (s.expiresAt && new Date(s.expiresAt).getTime() <= Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

function forget() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to do */
  }
}

function formatDuration(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export default function LivePage() {
  const { user, canCapture, loading: authLoading } = useAuth();

  const [session, setSession] = useState(null);
  const [pairCode, setPairCode] = useState(null);
  const [cards, setCards] = useState([]);
  const [client, setClient] = useState("waiting");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  const [playing, setPlaying] = useState(null);
  const [playBusy, setPlayBusy] = useState(null);
  const [playError, setPlayError] = useState("");
  const audioRef = useRef(null);
  const loadedFor = useRef(null);

  /**
   * Merge a card in by event id.
   *
   * The server dedupes, but the same card still arrives twice in one ordinary
   * case: the SSE push and the refetch that follows a reconnect. Keying by id
   * makes that harmless instead of showing the song twice.
   */
  const upsert = useCallback((card) => {
    setCards((prev) => {
      const next = prev.filter((c) => c.eventId !== card.eventId);
      next.unshift(card);
      return next.slice(0, KEEP_CARDS);
    });
  }, []);

  const loadFeed = useCallback(async (sessionId) => {
    try {
      const res = await captureAPI.liveFeed(sessionId, KEEP_CARDS);
      setCards(res.data.cards || []);
    } catch {
      // A failed refetch is not worth a message: the stream is still live and
      // the next card will arrive on its own.
    }
  }, []);

  // Restore a run that is still going.
  useEffect(() => {
    const saved = recall();
    if (!saved) return;
    setSession(saved);
    loadFeed(saved.id);
  }, [loadFeed]);

  // The stream. Reconnects are handled by EventSource itself; the refetch on
  // open is what fills in anything missed while it was down (decision 15).
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
   * client is still running (decision 16).
   */
  useEffect(() => {
    if (!session) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const res = await captureAPI.status(session.id);
        if (stop) return;
        setClient(res.data.client);
        if (res.data.ended) {
          setSession(null);
          forget();
        }
      } catch {
        /* a missed poll says nothing; the next one will answer */
      }
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => { stop = true; clearInterval(id); };
  }, [session]);

  const start = useCallback(async () => {
    setError("");
    setStarting(true);
    try {
      const res = await captureAPI.startLive({ label: "唱卡" });
      const s = res.data.session;
      setSession(s);
      setPairCode(res.data.pairCode);
      setCards([]);
      remember(s);
    } catch (err) {
      setError(err.response?.data?.error?.message || "无法开始，请稍后再试");
    } finally {
      setStarting(false);
    }
  }, []);

  const stop = useCallback(async () => {
    if (!session) return;
    try {
      await captureAPI.stop(session.id);
    } catch {
      // Already gone server-side is the same outcome as stopping it.
    }
    audioRef.current?.pause();
    setPlaying(null);
    setSession(null);
    setPairCode(null);
    setCards([]);
    forget();
  }, [session]);

  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;
    const el = new Audio();
    el.preload = "metadata";
    el.addEventListener("ended", () => setPlaying(null));
    audioRef.current = el;
    return el;
  }, []);

  /**
   * Play a card.
   *
   * Resolution happens here rather than when the card arrives: a round shows
   * several songs and only one gets sung, so resolving all of them would spend
   * platform requests on songs nobody asked for — the pattern that gets an IP
   * rate-limited (decision 53).
   */
  const play = useCallback(async (card) => {
    if (!card.mapping) return;
    setPlayError("");
    const el = ensureAudio();

    if (playing === card.eventId) {
      el.pause();
      setPlaying(null);
      return;
    }
    if (loadedFor.current === card.eventId && el.src) {
      await el.play().catch(() => {});
      setPlaying(card.eventId);
      return;
    }

    setPlayBusy(card.eventId);
    try {
      const res = await mappingAPI.preview(card.mapping.mappingId);
      const { url, reason, kind } = res.data;
      if (kind === "unsupported") {
        setPlayError(`${SOURCE_LABEL[card.mapping.source] || card.mapping.source} 的播放还没做`);
        return;
      }
      if (!url) {
        setPlayError(reason === "credential-expired"
          ? "音乐账号连接已失效，请到账号页重新扫码"
          : reason === "unavailable"
            ? "这首歌当前拿不到播放地址（可能需要会员或已下架）"
            : "无法播放");
        return;
      }
      el.src = url;
      loadedFor.current = card.eventId;
      await el.play();
      setPlaying(card.eventId);
    } catch (err) {
      setPlayError(err.response?.data?.error?.message || "播放失败");
    } finally {
      setPlayBusy(null);
    }
  }, [ensureAudio, playing]);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  if (authLoading) return null;

  if (!user) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center text-muted">
        请先登录。
      </div>
    );
  }

  if (!canCapture) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <h1 className="mb-2 text-lg font-medium">唱卡</h1>
        <p className="text-sm text-muted">
          唱卡是会员附加功能，开通后即可使用。
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">唱卡</h1>
          <p className="text-xs text-muted">
            游戏里出现的歌会自动出现在这里，点一下就能播放。
          </p>
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
              client === "connected"
                ? "bg-green-500"
                : client === "stale"
                  ? "bg-yellow-500"
                  : "bg-white/30"
            }`}
          />
          {client === "connected" ? "已连接" : client === "stale" ? "客户端没有响应" : "等待客户端连接"}
        </div>
      )}

      {playError && (
        <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {playError}
        </div>
      )}

      {!session ? (
        <div className="rounded border border-border bg-surface px-4 py-10 text-center text-sm text-muted">
          点「开始」后，在客户端里输入配对码即可。
        </div>
      ) : !cards.length ? (
        <div className="rounded border border-border bg-surface px-4 py-10 text-center text-sm text-muted">
          还没有捕捉到歌曲。
        </div>
      ) : (
        <ul className="space-y-2">
          {cards.map((card) => {
            const mapped = Boolean(card.mapping);
            const isPlaying = playing === card.eventId;
            return (
              <li
                key={card.eventId}
                className={`flex items-center gap-3 rounded border px-3 py-2.5 ${
                  mapped ? "border-border bg-surface" : "border-border/50 bg-surface/40"
                }`}
              >
                <button
                  type="button"
                  onClick={() => play(card)}
                  disabled={!mapped || playBusy === card.eventId}
                  title={mapped ? "播放" : "还没有配好这首歌"}
                  className="h-9 w-9 shrink-0 rounded-full border border-border text-xs hover:border-accent disabled:opacity-25"
                >
                  {playBusy === card.eventId ? "…" : isPlaying ? "❚❚" : "▶"}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{card.title}</div>
                  <div className="truncate text-xs text-muted">
                    {card.artist || "（无歌手）"}
                    {mapped && (
                      <>
                        {" · "}
                        {SOURCE_LABEL[card.mapping.source] || card.mapping.source}
                        {" · "}
                        {formatDuration(card.mapping.durationSec)}
                      </>
                    )}
                  </div>
                </div>

                {/* An unmapped song is the normal way a gap shows up, so it
                    says what it is rather than looking like a failure. */}
                {!mapped && (
                  <span className="shrink-0 rounded bg-black/20 px-2 py-0.5 text-[0.65rem] text-muted">
                    未配置
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
