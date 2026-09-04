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
import { captureAPI, mappingAPI, getLiveSSEUrl, getStreamUrl } from "@/lib/api";
import useAuth from "@/hooks/useAuth";
import useCaptureStore from "@/store/captureStore";
import useLivePlayer from "@/hooks/useLivePlayer";
import LiveLyrics from "@/components/live/LiveLyrics";
import LivePitchControl from "@/components/live/LivePitchControl";
import LiveSpeedControl from "@/components/live/LiveSpeedControl";
import SongPrefEditor, { SongPrefMarks } from "@/components/live/SongPrefTags";
import SongLibrary from "@/components/live/SongLibrary";
import MarkedSongs from "@/components/live/MarkedSongs";
import LiveGuide from "@/components/live/LiveGuide";
import DefaultTuning from "@/components/live/DefaultTuning";
import {
  loadStoredQuality, storeQuality, loadStoredVocals, storeVocals, QUALITY_TIERS,
} from "@/components/live/LiveVolumeControl";
import { PlayIcon, PauseIcon, BusyIcon, UnmappedIcon } from "@/components/live/TransportIcons";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { isCardWorthShowing, keepShowableCards } from "@/lib/liveCards";

// "独家" rather than "曲库": these are songs we hold ourselves, so they play
// without a platform account and cannot be delisted out from under a singer.
const SOURCE_LABEL = { LOCAL: "独家", QQ: "QQ", NETEASE: "网易" };

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

/**
 * Rounds kept on screen.
 *
 * Raised from 12 when the feed widened from one connection to a day: a dozen
 * rounds covered a single sitting and would now cut most of it off. Still a
 * cap rather than everything, because a day of singing should not become
 * endless scroll — the busiest measured account produced 553 cards in 24
 * hours, which is far more than anyone reads back through.
 */
const KEEP_BATCHES = 40;

/**
 * How long the stream may stay silent before it is presumed dead.
 *
 * The server sends a heartbeat comment every 10s, so silence past this is not
 * a quiet evening — it is a socket that stopped delivering without either end
 * being told. Set with the singer in mind rather than the network: a card that
 * takes 15s to appear is late, a card that never appears is the bug this
 * replaces.
 */
const SSE_SILENCE_MS = 15000;
/** Checked several times per timeout so the deadline is met, not lapped. */
const SSE_WATCHDOG_MS = 5000;

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
  const { user, canCapture, canEditMapping, loading: authLoading } = useAuth();
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
  // Cards whose passage marks a singer has reported (by eventId), so the
  // button flips to 已反馈 and cannot be tapped twice from the same card.
  // Session-local on purpose: the report itself is deduplicated server-side
  // by the passage's hash, so a second tap tomorrow just counts again.
  const [reportedCards, setReportedCards] = useState(() => new Set());
  // Playback lives in the hook: it starts an <audio> element straight away and
  // decodes in the background, so a card makes sound in well under a second
  // while pitch shifting becomes available a moment later.
  const player = useLivePlayer();
  const { isPlaying: playing, current, duration } = player;
  const [approving, setApproving] = useState(false);
  /**
   * May this account decide mappings?
   *
   * Starts from the account rather than at `true`, so a listener never sees a
   * 就是这个 that was only ever going to 403. It can still be turned off by a
   * refusal: the flag is hand-granted and can be revoked while a page is open,
   * and the server is the authority either way.
   */
  const [canApprove, setCanApprove] = useState(canEditMapping);
  /**
   * Set once the server has refused, and never unset.
   *
   * The flag below is read from `me()`, which is minutes old; a refusal is the
   * present tense. Without this the effect would put the buttons back every
   * time the user object changed identity -- changing a preference is enough --
   * so a revoked editor would watch them reappear and 403 again on every press.
   */
  const refused = useRef(false);
  // The page renders before `me()` lands, so the flag arrives late on a cold
  // load. Follow it up, but never past a refusal.
  useEffect(() => {
    if (canEditMapping && !refused.current) setCanApprove(true);
  }, [canEditMapping]);

  /**
   * What each singer has settled on for a recording, keyed `SOURCE:externalId`.
   *
   * Keyed on the recording rather than the card, because the same song can be
   * on screen twice -- the game offers it in one round and again in a later
   * one -- and both cards must show the same marks and save to the same row.
   *
   * Seeded from the feed, which returns preferences alongside the cards, so no
   * request of its own is needed on load.
   */
  const [prefs, setPrefs] = useState({});
  // Which half of the page is showing. "cards" is what the game feeds; "library"
  // is the same marks reachable without a game running. Held here rather than
  // in the URL because it is a view toggle, not a place: a reload should put
  // the singer back on the cards, which is where a running game needs them.
  const [tab, setTab] = useState("cards");
  // Shown when a member without the add-on reaches for a gated action. The
  // page is visible to everyone now — the gate moved from a whole-page block
  // to the individual entry points, so the feature is discoverable and the
  // price reaches the people who would pay it, the same way 自动打标 does.
  const [showAddOnNotice, setShowAddOnNotice] = useState(false);
  /**
   * The key and tempo a song opens in when it has none of its own.
   *
   * Held here rather than written onto each song: a song that has never been
   * adjusted stays that way, so changing this later moves all of them at once.
   * Null means no default has been set, which is not the same as a default of
   * 0 and 1.0 -- the distinction is what lets "unset" and "deliberately the
   * original" stay apart, here as on the songs themselves.
   */
  const [defaults, setDefaults] = useState(null);

  /**
   * Which file plays: a quality tier, and whether to use the vocals-only
   * track where the platform has one.
   *
   * Device settings like the volume, so localStorage rather than the account —
   * and read on mount rather than initialised from it, because the server
   * renders this first and has no localStorage to read.
   */
  const [quality, setQualityState] = useState("mp3_128");
  const [vocalsOnly, setVocalsOnlyState] = useState(false);
  /** Null until a card has been opened and the platform has answered. */
  const [vocalsAvailable, setVocalsAvailable] = useState(null);
  useEffect(() => {
    setQualityState(loadStoredQuality());
    setVocalsOnlyState(loadStoredVocals());
  }, []);
  const prefKey = useCallback(
    (mapping) => (mapping ? `${mapping.source}:${mapping.externalId}` : null),
    []
  );

  /**
   * Whether the singer has actually moved the key or tempo on the open card.
   *
   * Without this, closing a card would write whatever the player happened to
   * be holding -- and the player keeps the last song's values until the next
   * one changes them, so opening a card and closing it untouched would stamp
   * the previous song's key onto this song. Only a deliberate move counts.
   */
  const touchedRef = useRef(false);
  /**
   * What is open, readable from a cleanup that must not re-run when it changes.
   *
   * The save happens on close, and close is also what unmounts the page. Both
   * paths need the card and its values as they are at that instant, which is
   * exactly what state closed over by an effect cannot give.
   */
  const openCardRef = useRef(null);
  const settingsRef = useRef({ pitch: 0, speed: 1 });
  settingsRef.current = { pitch: player.pitch, speed: player.speed };

  /**
   * Store the key and tempo the singer settled on for the card being closed.
   *
   * On close rather than on every change, because the values in between are
   * not decisions -- a singer tries +3, finds it too high and comes back down,
   * and only where they stop is worth remembering. It also means no debounce:
   * the button repeats while being held, and a per-change save would write
   * once per press.
   *
   * 0 and 1.0 are saved like any other value. Trying +2 and settling back on
   * the original is a decision, and storing it is different from never having
   * tried -- the next round then opens in the key that was chosen rather than
   * the one that was never considered.
   */
  const saveOpenCardSettings = useCallback(() => {
    const card = openCardRef.current;
    openCardRef.current = null;
    if (!touchedRef.current) return;
    touchedRef.current = false;
    if (!card || !card.mapping) return;

    const key = prefKey(card.mapping);
    const { pitch, speed } = settingsRef.current;
    // Optimistic: the row it writes is the one the page already shows, so
    // waiting for the round trip would only delay agreeing with itself.
    setPrefs((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), pitch, speed } }));
    captureAPI
      .saveSongPref(card.mapping.source, card.mapping.externalId, { pitch, speed })
      .catch(() => {
        /* A preference that failed to save is a small loss and a bad reason to
           interrupt someone about to sing. It is retried the next time they
           close the card. */
      });
  }, [prefKey]);

  const loadedFor = useRef(null);
  /**
   * Start times of the open card's lyric lines, for w/s.
   *
   * A ref rather than state: nothing renders from it, and holding it in state
   * would re-render the card every time the lyrics finished loading. The setter
   * is stable, which matters — LiveLyrics reports through it from an effect,
   * and a new function identity each render would make that effect loop.
   */
  const lineTimes = useRef([]);
  const setLineTimes = useCallback((times) => { lineTimes.current = times || []; }, []);

  /**
   * Where in the song the passage the game is showing occurs.
   *
   * State rather than a ref, unlike the line times above: these are drawn on
   * the progress bar, so the bar has to re-render when they arrive. The
   * comparison keeps that to once per song — the reporting effect re-runs
   * whenever the lyrics re-parse, and an unguarded set would re-render on
   * every one of those.
   */
  const [passageTimes, setPassageTimes] = useState([]);
  const onPassageTimes = useCallback((times) => {
    setPassageTimes((prev) => {
      const next = times || [];
      if (prev.length === next.length && prev.every((t, i) => t === next[i])) return prev;
      return next;
    });
  }, []);

  const batches = useMemo(() => toBatches(cards), [cards]);

  /**
   * Merge a card in by event id.
   *
   * The server dedupes, but the same card still arrives twice in one ordinary
   * case: the SSE push and the refetch that follows a reconnect. Keying by id
   * makes that harmless instead of showing the song twice.
   */
  const upsert = useCallback((card) => {
    // A half-read capture never reaches the list — see isCardWorthShowing. It
    // has to be filtered here rather than at render, because the rounds are
    // built from this list: left in, one of these opens a round of its own and
    // folds away the round the singer is reading.
    if (!isCardWorthShowing(card)) return;
    setCards((prev) => [card, ...prev.filter((c) => c.eventId !== card.eventId)]);
    // A pushed card carries no preferences -- ingest answers before it could
    // read them -- so a song already marked keeps the marks the feed seeded.
    // Only clear-out is wrong here, and nothing here clears.
    if (card.mapping && card.prefs) {
      setPrefs((prev) => ({
        ...prev,
        [`${card.mapping.source}:${card.mapping.externalId}`]: card.prefs,
      }));
    }
  }, []);

  const loadFeed = useCallback(async (sessionId) => {
    try {
      // The feed now spans a day rather than one connection, so ask for enough to
    // fill it: the busiest measured account sang 553 songs in 24 hours, and 150
    // rounds of that is more than anyone scrolls.
    const res = await captureAPI.liveFeed(sessionId, 150);
      // Filtered on the way in, exactly as pushed cards are: a refetch must not
      // put back what a push already left out, or every reconnect would undo it.
      const fresh = keepShowableCards(res.data.cards || []);
      setCards(fresh);
      // The feed carries each card's stored preferences, so seeding here costs
      // no extra request. Merged rather than replaced: a card the singer just
      // marked may have scrolled out of this window, and its marks should not
      // vanish because the feed no longer mentions it.
      setPrefs((prev) => {
        const next = { ...prev };
        for (const c of fresh) {
          if (c.mapping && c.prefs) next[`${c.mapping.source}:${c.mapping.externalId}`] = c.prefs;
        }
        return next;
      });
      // Carried by the same response, so this costs no request of its own.
      if (res.data.defaults !== undefined) setDefaults(res.data.defaults);
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

  /**
   * The stream, and the two things that keep it honest.
   *
   * EventSource reconnects itself when it *notices* a break, and the refetch on
   * open fills in whatever arrived while it was down. The failure this page
   * kept hitting is the case where it never notices: a phone freezes the tab,
   * a network hands over from wifi to mobile, or iOS 18 leaves readyState at
   * OPEN with the socket already gone. No error fires, so no reconnect, so no
   * refetch — and every card pushed from then on is written into a socket
   * nobody reads. The singer sees the feed stop, and a manual refresh brings
   * all of it back, because the cards were in the database the whole time.
   *
   * So the page stops trusting the connection to report its own death:
   *
   *  - the server sends a comment every 10s, and anything arriving on the
   *    stream (a card, a heartbeat, the opening ':ok') counts as proof of life.
   *    Silence past SSE_SILENCE_MS means the link is gone whatever readyState
   *    claims, and the stream is torn down and rebuilt.
   *  - coming back to the tab reconnects immediately rather than waiting out
   *    that timeout. Leaving to look a song up in a music app and returning is
   *    the ordinary way this page is used, not an edge case.
   */
  useEffect(() => {
    if (!session) return undefined;
    let es = null;
    let watchdog = null;
    let closed = false;
    let lastMessageAt = Date.now();

    const connect = () => {
      if (closed) return;
      if (es) {
        try { es.close(); } catch { /* already gone */ }
      }
      lastMessageAt = Date.now();
      es = new EventSource(getLiveSSEUrl(session.id));
      // Any traffic at all is proof the link is alive — heartbeats included,
      // which is the whole point of the server sending them.
      const seen = () => { lastMessageAt = Date.now(); };
      es.addEventListener("message", seen);
      es.addEventListener("open", () => {
        seen();
        // Whatever was pushed while this was down is still in the database.
        loadFeed(session.id);
      });
      es.addEventListener("live-card", (e) => {
        seen();
        try {
          upsert(JSON.parse(e.data));
        } catch {
          /* a malformed frame is not worth tearing the stream down for */
        }
      });
      // The server's keep-alive, and the only traffic on a stream that is
      // healthy but idle between songs. Without listening for it the watchdog
      // below saw silence on a working connection and rebuilt it every ~20s,
      // losing any card pushed while it was down.
      es.addEventListener("heartbeat", seen);
      // An error the browser *does* report: let EventSource retry on its own,
      // and let the watchdog step in if that retry never lands.
      es.addEventListener("error", seen);
    };

    connect();

    // Checked more often than the timeout it enforces, so a dead link is found
    // within a few seconds of the deadline rather than a whole period later.
    watchdog = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastMessageAt > SSE_SILENCE_MS) connect();
    }, SSE_WATCHDOG_MS);

    // Back on screen: reconnect now instead of waiting for the watchdog, and
    // let the reconnect's own open handler pull in what was missed.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || closed) return;
      loadFeed(session.id);
      connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);

    return () => {
      closed = true;
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
      if (es) { try { es.close(); } catch { /* already gone */ } }
    };
  }, [session, upsert, loadFeed]);

  /**
   * Poll for liveness, and for cards this page never received.
   *
   * Liveness is deliberately not inferred from the SSE connection: that only
   * proves the browser can reach the server, which says nothing about whether
   * the capture client is still running.
   *
   * The count is the second half of the safety net around the stream. The
   * watchdog asks "is the link alive"; this asks the question that actually
   * matters — "does the server have cards I do not?" — and answers it without
   * having to detect anything about the connection at all. Both windows are
   * the same 15s, so a card lost to any cause surfaces within one of them.
   */
  const cardCountRef = useRef(0);
  cardCountRef.current = cards.length;
  useEffect(() => {
    if (!session) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const res = await captureAPI.status(session.id);
        if (stop) return;
        setClient(res.data.client);
        // Held fewer than the server has: something was pushed while this page
        // was not listening. The feed is the authority, so take it whole.
        const serverCount = res.data.liveEventCount;
        if (typeof serverCount === "number" && serverCount > cardCountRef.current) {
          loadFeed(session.id);
        }
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
    // cards is read through a ref rather than depended on: the poll must keep
    // its own cadence, not restart every time a card arrives.
  }, [session, loadFeed]);

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
  /**
   * Say so when the file that played is not the one that was asked for.
   *
   * The platform withholds individual files, so a request for 无损 or 只听人声
   * can come back as something lesser — and silence about that is its own
   * fault: the singer chose a setting, heard a song, and had no way to know
   * the setting had not applied. Naming what did play is what lets them decide
   * whether it matters.
   *
   * Not an error, so it goes through the same line as one only because that is
   * where the page already speaks. Empty when nothing was substituted.
   */
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

  const playCard = useCallback(async (card) => {
    if (!card.mapping) return;
    setPlayError("");
    /**
     * Whether a separated vocal track exists is a fact about one recording, so
     * it has to be forgotten when a different one is opened.
     *
     * It was not, and the checkbox is disabled while the answer is false — so
     * the one control that could set it back to true was the one control the
     * user could no longer reach. One song without a vocal track turned the
     * feature off for the rest of the session, and only reloading the page
     * brought it back. Reproduced by walking the state machine: song 1 fine,
     * song 2 without vocals, songs 3 and 4 unreachable.
     *
     * Null rather than true: unknown until this song is asked about, which is
     * also what lets the checkbox stay usable.
     */
    setVocalsAvailable(null);

    // The card's own recording, and the only one it has: a card plays one
    // song. That is what keeps a saved key honest -- the preference stored
    // while this card is open belongs to what was sounding under it.
    const key = card.eventId;

    // Same track again: pause or resume rather than reloading, so the position
    // and any decode already done survive.
    if (loadedFor.current === key) {
      await player.toggle();
      return;
    }

    setBusy(true);
    // Temporary: the three legs of the wait before the key can be shifted —
    // resolving an address, downloading the file, decoding it. Timed on the
    // devices that actually find this slow, because the cure differs per leg.
    const tOpen = Date.now();
    try {
      const res = await mappingAPI.preview(card.mapping.mappingId, undefined, {
        tier: quality, vocalsOnly,
      });
      const resolveMs = Date.now() - tOpen;
      // Every timing the player takes for this card comes back through here,
      // labelled by kind: `play` is the wait before sound, `ready` the wait
      // before the key can be shifted, `pitch`/`vocals` how long an adjustment
      // took and whether it was even possible yet. Context the player cannot
      // know — which song, which quality — is added on the way out.
      player.perfRef.current = (legs) => {
        captureAPI.perf({
          ...legs,
          resolveMs,
          source: card.mapping.source,
          tier: quality,
          vocalsOnly: vocalsOnly ? 1 : 0,
        });
      };
      const { url, reason, kind, songId } = res.data;
      if (kind === "unsupported") {
        setPlayError(`${SOURCE_LABEL[card.mapping.source] || card.mapping.source} 的播放还没做`);
        return;
      }
      // A song we hold ourselves. The address is built here rather than sent,
      // because the stream route wants a token and an <audio> element can only
      // carry one in the query string — which is what this helper does, and
      // what the playlist player has always done.
      if (kind === "local" && songId) {
        loadedFor.current = key;
        await player.load(getStreamUrl(songId));
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
      // What actually played, not what was asked for: the server may have had
      // to substitute, and telling the player otherwise would have it separate
      // channels on a file that has none.
      await player.setVocalsOnly(res.data.vocalsPlayed === true);
      // After the sound starts, so saying it never delays hearing it.
      const note = fallbackNotice(res.data, { tier: quality, vocalsOnly });
      if (note) setPlayError(note);
    } catch (err) {
      setPlayError(err.response?.data?.error?.message || "播放失败");
    } finally {
      setBusy(false);
    }
  }, [player, quality, vocalsOnly]);

  /**
   * Navigating away is a close too.
   *
   * Empty deps and a ref-based save on purpose: this must run once, when the
   * page goes, reading the values as they are at that moment. A dependency
   * would make it run on every change and save mid-adjustment.
   */
  const saveRef = useRef(saveOpenCardSettings);
  saveRef.current = saveOpenCardSettings;
  useEffect(() => () => saveRef.current(), []);

  /**
   * Put the open card into the key and tempo it should sound in.
   *
   * Every card gets an answer, including the ones nobody has marked: a song
   * never adjusted sounds in its original key at normal speed. That has to be
   * applied rather than assumed, because the player carries its values across
   * songs -- stopping and loading a new track resets the position and the
   * decode but not the pitch or the tempo. Left alone, a song adjusted to +4
   * would hand that +4 to the next song opened, which is both wrong to hear
   * and, if the singer then touches any control, wrong to save.
   *
   * The defaults are held here rather than written to the database when a card
   * opens. Storing them would put a row behind every song ever glanced at, and
   * would destroy the one thing a stored 0 means -- that this singer tried
   * something else and decided the original was right.
   *
   * Tempo takes effect the moment the card opens: the <audio> element's own
   * playbackRate needs nothing decoded.
   *
   * Key cannot. Shifting pitch runs on a decoded buffer, which lands a second
   * or two after the first sound -- so a remembered key arrives mid-phrase and
   * the opening bars play in the original. That is the accepted trade: sound
   * starts immediately, as the page was built to do, and the alternative
   * (holding the audio until the decode finished) would make every card slower
   * to serve the ones that are remembered. Returning to the original key needs
   * no decode at all, so the common case is instant either way.
   *
   * `appliedFor` guards against re-running: without it, applying a value would
   * change player.pitch, which would re-run this effect, and the singer's own
   * later adjustment would be undone by it.
   */
  const appliedFor = useRef(null);
  useEffect(() => {
    if (!openId) { appliedFor.current = null; return; }
    const card = cards.find((c) => c.eventId === openId);
    if (!card || !card.mapping) return;
    // No stored preference is not "do nothing" -- it is "the original", which
    // is a value like any other and has to be applied for the same reason.
    // Three tiers, narrowest first: what this song was set to, else this
    // singer's default, else the original. The default is consulted rather
    // than copied onto the song, so a song that has never been adjusted stays
    // that way and follows the default when it changes.
    const saved = prefs[prefKey(card.mapping)] || {};
    const wantSpeed = typeof saved.speed === "number" ? saved.speed
      : (typeof defaults?.speed === "number" ? defaults.speed : 1);
    const wantPitch = typeof saved.pitch === "number" ? saved.pitch
      : (typeof defaults?.pitch === "number" ? defaults.pitch : 0);

    // Tempo first, and once per card.
    if (appliedFor.current !== `${openId}:speed` && appliedFor.current !== `${openId}:both`) {
      if (wantSpeed !== player.speed) player.setSpeed(wantSpeed);
      appliedFor.current = `${openId}:speed`;
    }

    // Key, once the decode has landed and made it possible at all.
    //
    // Returning to 0 is the one case that does not need the decode: setPitch
    // tears the shifted graph down and hands playback back to the element. But
    // it is still gated on canShift, so that both directions settle at the
    // same moment rather than the key snapping back before a remembered one
    // could arrive.
    if (player.canShift && appliedFor.current !== `${openId}:both`) {
      if (wantPitch !== player.pitch) player.setPitch(wantPitch);
      appliedFor.current = `${openId}:both`;
    }
    // `player` itself is deliberately absent: the hook returns a fresh object
    // literal every render, so depending on it would re-run this effect on
    // every render -- including the ones this effect causes by applying a
    // value. The individual fields below are primitives and stable callbacks.
  }, [openId, cards, prefs, defaults, prefKey, player.canShift, player.speed,
    player.pitch, player.setSpeed, player.setPitch]);

  /**
   * The singer moved a control themselves.
   *
   * Wrapped rather than watching player.pitch, because this feature's own
   * writes move that value too -- applying a remembered key would look
   * identical to choosing one, and an untouched card would save itself.
   */
  const { setPitch: playerSetPitch, setSpeed: playerSetSpeed } = player;
  const changePitch = useCallback((value) => {
    touchedRef.current = true;
    playerSetPitch(value);
  }, [playerSetPitch]);

  const changeSpeed = useCallback((value) => {
    touchedRef.current = true;
    playerSetSpeed(value);
  }, [playerSetSpeed]);

  /**
   * Change the singer's default key or tempo.
   *
   * It also moves whatever card is open, and that is the point: choosing a
   * default by ear is impossible if you cannot hear it. So the control acts on
   * the song in front of you as well as on the setting.
   *
   * What it does NOT do is give that song a memory it did not have. A song
   * with its own setting has that setting updated -- the singer is adjusting
   * the thing they are listening to, and it already had an opinion. A song
   * without one simply follows the new default, exactly as it was already
   * following the old one, and still has nothing stored.
   *
   * `touchedRef` is deliberately left alone. It marks the card's own controls
   * having been moved, which is what makes a close write a memory; setting it
   * here would mean adjusting the default silently pinned the open song to it.
   */
  const changeDefaults = useCallback((patch) => {
    setDefaults((prev) => ({ pitch: null, speed: null, ...(prev || {}), ...patch }));
    captureAPI.saveSongPrefDefaults(patch).catch(() => {
      /* A default that failed to save is a small loss and a bad reason to
         interrupt someone about to sing; the next change retries it. */
    });

    // Apply it to what is playing, and let the effect below re-run for the
    // rest -- it reads `defaults`, which has just changed.
    if (typeof patch.speed === "number") playerSetSpeed(patch.speed);
    if (typeof patch.pitch === "number" && player.canShift) playerSetPitch(patch.pitch);

    // A song that already had its own setting is following the singer's hand,
    // so its stored value moves with it. One that had none keeps none.
    const card = openId ? cards.find((c) => c.eventId === openId) : null;
    if (!card || !card.mapping) return;
    const key = prefKey(card.mapping);
    const own = prefs[key];
    if (!own) return;
    const hasOwnPitch = typeof own.pitch === "number";
    const hasOwnSpeed = typeof own.speed === "number";
    const update = {};
    if (patch.pitch !== undefined && hasOwnPitch) update.pitch = patch.pitch;
    if (patch.speed !== undefined && hasOwnSpeed) update.speed = patch.speed;
    if (!Object.keys(update).length) return;

    setPrefs((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ...update } }));
    captureAPI
      .saveSongPref(card.mapping.source, card.mapping.externalId, update)
      .catch(() => { /* as above */ });
  }, [openId, cards, prefs, prefKey, playerSetSpeed, playerSetPitch, player.canShift]);

  /**
   * Change which file plays, without stopping the one that is.
   *
   * Both settings pick a different audio file for the song already sounding,
   * so applying them means a new URL mid-line. Assigning it to the playing
   * element would cut the sound and restart it; instead the player loads the
   * new file quietly and takes over at the same position, which the singer
   * hears as the music simply continuing.
   *
   * Nothing playing is the easy case: the setting is stored and the next card
   * to open uses it.
   */
  const applyPlaybackSetting = useCallback(async (next) => {
    const card = openId ? cards.find((c) => c.eventId === openId) : null;
    if (!card?.mapping || !playing) return;
    // Temporary: a quality or vocals switch fetches a different file for a song
    // already sounding, so the singer waits through a second resolve and a
    // second load with the music still playing. How long that takes is its own
    // question, separate from opening a card.
    const tSwap = Date.now();
    let tResolved = tSwap;
    try {
      const res = await mappingAPI.preview(card.mapping.mappingId, undefined, next);
      tResolved = Date.now();
      const { url, kind, songId } = res.data;
      // A local song has no tiers and no separated vocals; it plays as it is.
      if (kind === "local" && songId) return;
      if (!url) {
        // Nothing on the server's ladder played, so this is not the vocal stem
        // being absent — that now falls back to the full mix and returns a url.
        // Reaching here means the song itself is unavailable, and turning the
        // vocals setting off would hide that behind a change the singer did
        // not make.
        setPlayError("这首歌暂时播放不了");
        return;
      }
      // Whether this song actually had a vocal stem, as opposed to whether one
      // was asked for. The server falls back rather than refusing, so a url
      // coming back no longer means the request was met.
      if (next.vocalsOnly) setVocalsAvailable(res.data.vocalsPlayed === true);
      await player.swapSource(url);
      // Guarded: this sits inside the try that governs the swap, so a
      // synchronous throw from the reporting call — which its own .catch()
      // cannot intercept — would skip the setVocalsOnly below and leave the
      // singer with the backing track they just turned off.
      try {
        captureAPI.perf({
          kind: "swap",
          resolveMs: tResolved - tSwap,
          ms: Date.now() - tSwap,
          source: card.mapping.source,
          tier: next.tier || quality,
          vocalsOnly: next.vocalsOnly ? 1 : 0,
        });
      } catch { /* a measurement is never worth a wrong track */ }
      // The separated file carries the voice in channels 0 and 1 and the
      // backing in 2 and 3, so choosing the file is only half of it — an
      // <audio> element mixes all four back together. The player takes the
      // first pair once the track has decoded.
      await player.setVocalsOnly(res.data.vocalsPlayed === true);
      const note = fallbackNotice(res.data, next);
      if (note) setPlayError(note);
    } catch (err) {
      setPlayError(err.response?.data?.error?.message || "切换失败");
    }
  }, [openId, cards, playing, player]);

  const changeQuality = useCallback((tier) => {
    setQualityState(tier);
    storeQuality(tier);
    applyPlaybackSetting({ tier, vocalsOnly });
  }, [vocalsOnly, applyPlaybackSetting]);

  const changeVocalsOnly = useCallback((on) => {
    setVocalsOnlyState(on);
    storeVocals(on);
    applyPlaybackSetting({ tier: quality, vocalsOnly: on });
  }, [quality, applyPlaybackSetting]);

  /**
   * Colours and the note, which commit as they are made.
   *
   * Unlike the key and tempo these are stated outright rather than arrived at
   * by ear, so there is no trying-out phase worth waiting through.
   */
  const changeMarks = useCallback((card, patch) => {
    if (!card.mapping) return;
    const key = prefKey(card.mapping);
    setPrefs((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ...patch } }));
    captureAPI
      .saveSongPref(card.mapping.source, card.mapping.externalId, patch)
      .catch(() => { /* see saveOpenCardSettings */ });
  }, [prefKey]);

  /** Open a card, or close the one that is open. */
  const toggleCard = useCallback((card) => {
    // Before anything else: the card being left owns the key and tempo the
    // player is still holding, and stopAudio does not reset them.
    saveOpenCardSettings();
    stopAudio();
    setPlayError("");
    // The line times: the next card's lyrics are a fetch away, and
    // until they land w/s would jump to positions belonging to the song that
    // was open before.
    setLineTimes([]);
    // The marks belong to the song being closed; the next card's lyrics are a
    // fetch away, and stale marks would sit on the new song's transport.
    setPassageTimes([]);
    if (openId === card.eventId) {
      setOpenId(null);
      return;
    }
    setOpenId(card.eventId);
    openCardRef.current = card;
    if (!card.mapping) return;
    playCard(card);
  }, [openId, stopAudio, playCard, setLineTimes, saveOpenCardSettings]);

  /**
   * Play or pause this card's recording.
   *
   * A card plays one recording and only one, so this is `playCard` by another
   * name -- kept because the transport and the spacebar both call it, and
   * because playCard's second argument no longer has any caller that should
   * be passing one.
   */
  const togglePlayback = useCallback((card) => playCard(card), [playCard]);

  /**
   * Space to play or pause, arrows to nudge a second either way.
   *
   * Someone practising has both hands occupied and their eyes on the words;
   * reaching for a 32px button to shift the playhead by a beat is the part of
   * this that was hardest to do while actually singing.
   *
   * Only while a card is open, and never while typing -- the page has a search
   * box, and a space that pauses the music instead of typing a space is worse
   * than no shortcut at all.
   */
  useEffect(() => {
    if (!openId) return undefined;
    const onKey = (e) => {
      const el = e.target;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
        || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const card = cards.find((c) => c.eventId === openId);
      if (!card) return;

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      /**
       * Jump to the start of the previous or next lyric line.
       *
       * Nothing is fetched: the times were parsed when the words were drawn,
       * and this reads that array. Seeking backwards has to look before the
       * line currently playing, not at it — a second into a line, "previous"
       * means the one before, not the top of this one, or the key would only
       * ever restart the same line.
       */
      const jumpLine = (dir) => {
        const times = lineTimes.current;
        if (!times.length) return;
        const now = player.current;
        if (dir < 0) {
          // A small grace period, so the key repeats through lines rather than
          // sticking on the boundary it just landed on.
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
        togglePlayback(card);
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
      // Up and Down are deliberately left alone. This listener is on the
      // window, not the card, so claiming them would stop the page scrolling
      // for as long as any card is open -- and Up/Down is what a reader
      // scrolls a long list of rounds with. Left/Right never scrolled, so
      // taking those costs nothing.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, cards, togglePlayback, player]);

  /**
   * Confirm this card's match: the recording it plays is the right one.
   *
   * The only mapping decision left on this page, and deliberately so. It is
   * the one that needs the context the page has and the review page does not
   * -- the song was on screen a moment ago and has just been heard, so
   * "yes, that is it" is answerable here and nowhere else.
   *
   * Rejecting is not offered alongside it, though it looks like the natural
   * pair. It deletes the recording from the catalogue, taking every other
   * mapping that names it and every singer's saved key with it; that belongs
   * on the review page, where its consequences are shown before it is done.
   *
   * Whatever the card points at is what gets confirmed. There is no second
   * recording in play any more, which is what makes the saved key safe: the
   * preference the singer stores while this card is open belongs to the same
   * recording throughout.
   */
  const approve = useCallback(async (card) => {
    // The button is already hidden; this is the same answer stated where the
    // work would start, so a stale handle or a future caller cannot reach it.
    if (!canApprove || !card.mapping) return;
    setApproving(true);
    try {
      await mappingAPI.approve(card.mapping.mappingId);
      setCards((prev) => prev.map((c) => (c.eventId === card.eventId
        ? { ...c, mapping: { ...c.mapping, approved: true } }
        : c)));
    } catch (err) {
      // A 403 means this account simply lacks the flag. Say so once and stop
      // offering the button rather than failing every time it is pressed.
      if (err.response?.status === 403) { refused.current = true; setCanApprove(false); }
      else setPlayError(err.response?.data?.error?.message || "确认失败");
    } finally {
      setApproving(false);
    }
  }, [canApprove]);

  const start = useCallback(async () => {
    // Explain the add-on rather than firing a request that will 403, the same
    // as 自动打标. The button stays live so a member can find the feature.
    if (!canCapture) {
      setShowAddOnNotice(true);
      return;
    }
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
  }, [aim, canCapture]);

  const stop = useCallback(async () => {
    if (!session) return;
    // Stops delivery, not the connection: the client stays paired so the next
    // round -- here or in a playlist -- costs nothing to start.
    // Ending the run closes whatever card was open, and that close deserves
    // the same save as one made by hand.
    saveOpenCardSettings();
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

  // The add-on gate is no longer a whole-page block: the page renders for any
  // member so the feature can be seen and tried. Each gated action — 开始, and
  // the 标记 / 已标记 tabs — checks canCapture itself and shows the add-on
  // notice instead of firing a request the server would 403 anyway.

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">唱卡</h1>
          <p className="text-xs text-muted">游戏里出现的歌会自动出现在这里，点开即可播放。</p>
        </div>
        {/* Starting and stopping belong to the cards, so the button follows
            them. Leaving it visible over the library would offer to start a
            game from a screen that has nothing to do with one. */}
        {tab !== "cards" ? null : session ? (
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

      {/* A running game keeps running while the library is open: switching tabs
          hides the cards, it does not stop delivery. */}
      <div className="mb-4 flex items-center gap-1 border-b border-border">
        {[["cards", "唱卡"], ["library", "标记"], ["marked", "已标记"]].map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors ${
              tab === id
                ? "border-accent text-fg"
                : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 标记 / 已标记 read from gated routes, so a member without the add-on
          sees the same notice here rather than an empty list from a 403. */}
      {(tab === "library" || tab === "marked") && !canCapture ? (
        <div className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-muted">
          这是加订版功能，开通后即可搜索曲库、给歌曲标记。
        </div>
      ) : null}
      {tab === "library" && canCapture ? <SongLibrary /> : null}
      {tab === "marked" && canCapture ? <MarkedSongs /> : null}

      {error && (
        <div className="mb-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* The code is the whole point of the empty state: until it is typed into
          the client, nothing can arrive and the page would just look broken. */}
      {tab === "cards" && session && pairCode && client !== "connected" && (
        <div className="mb-4 rounded border border-border bg-surface px-4 py-3">
          <div className="text-xs text-muted">在手机客户端里输入配对码</div>
          <div className="mt-1 font-mono text-2xl tracking-widest">{pairCode}</div>
        </div>
      )}

      {tab === "cards" && session && (
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

      {tab !== "cards" ? null : !session ? (
        /* The 唱卡 how-to, in place of the pairing hint. Shown only while no
           run is on, so pressing 开始 clears it and play is never interrupted.
           Five collapsible sections, all collapsed by default — reference
           material to open when wanted, not a banner. */
        <LiveGuide />
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
                  onClick={() => {
                    // Folding a round away takes its open card with it. Without
                    // this the panel disappears while the song plays on, the
                    // spacebar still toggles a card nobody can see, and any
                    // audition survives to be confirmed later against a card
                    // the user has lost track of.
                    if (!isCollapsed && batch.cards.some((c) => c.eventId === openId)) {
                      stopAudio();
                      setOpenId(null);
                      setRejecting(null);
                    }
                    setCollapsed((p) => ({ ...p, [batch.at]: !isCollapsed }));
                  }}
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
                            {/* flex rather than leading-8: line-height centres
                                text by its own metrics, which an icon does not
                                have. */}
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border">
                              {!mapped ? <UnmappedIcon className="text-muted" />
                                : busy && isOpen ? <BusyIcon />
                                  : isOpen && playing ? <PauseIcon /> : <PlayIcon />}
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
                              {/* On a phone the marks get a line of their own
                                  under the artist: inline they and the title
                                  fought over ~230px and the note always won,
                                  leaving the title an ellipsis. Both matter,
                                  so neither yields — the row grows instead.
                                  Rendered only when marks exist, so unmarked
                                  cards keep exactly today's height. */}
                              {mapped && (prefs[prefKey(card.mapping)]?.note
                                || prefs[prefKey(card.mapping)]?.colorTag) ? (
                                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 sm:hidden">
                                  <SongPrefMarks prefs={prefs[prefKey(card.mapping)]} />
                                </span>
                              ) : null}
                            </span>
                            {/* The singer's own marks, before the status
                                badge: a note and colours are theirs, and the
                                badge is the site's judgement of the recording.
                                Renders nothing when the song has never been
                                marked, so an untouched card is unchanged.
                                Desktop only — the phone shows them on their
                                own line above, where both they and the title
                                fit whole. `contents` keeps them direct flex
                                children of the row, exactly as before. */}
                            {mapped ? (
                              <span className="hidden sm:contents">
                                <SongPrefMarks prefs={prefs[prefKey(card.mapping)]} />
                              </span>
                            ) : null}
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
                            // The expanded area sits a touch darker than the
                            // card. On the dark grounds that tenth of black is
                            // right; on the light ones it read as a heavy grey,
                            // so it is halved there. dark: keys off the .dark
                            // class the dark grounds carry and the light do not.
                            <div className="border-t border-border/40 bg-black/5 px-3 py-3 dark:bg-black/10">
                              {playError && (
                                <div className="mb-2 text-xs text-red-400">{playError}</div>
                              )}

                              {/* Words first, transport underneath.
                                  Someone singing is reading the lyrics and
                                  reaching for the controls without looking, so
                                  the reading sits where the eyes already are
                                  and the buttons stay under the thumb. Every
                                  music player worth copying is laid out this
                                  way. */}
                              <div className="border-t border-border/40 pt-1">
                                <LiveLyrics
                                  mappingId={card.mapping.mappingId}
                                  gameLyric={card.lyric}
                                  current={current}
                                  onSeek={player.seek}
                                  onTimesChange={setLineTimes}
                                  onPassageTimes={onPassageTimes}
                                />
                              </div>

                              <div className="mt-2 flex items-center gap-2">
                                <div
                                  role="presentation"
                                  onClick={(e) => {
                                    const r = e.currentTarget.getBoundingClientRect();
                                    if (duration <= 0 || r.width <= 0) return;
                                    const clickTime = ((e.clientX - r.left) / r.width) * duration;
                                    // Snap to a passage marker when the click lands
                                    // near one: the 10px dots are hard to hit,
                                    // especially on a phone, so a click within
                                    // ~24px of a marker seeks to the marker itself
                                    // rather than to where the finger happened to
                                    // land. Nearest marker wins; nothing snaps if
                                    // none is close, so scrubbing elsewhere is
                                    // unaffected.
                                    const SNAP_PX = 24;
                                    const snapSec = (SNAP_PX / r.width) * duration;
                                    let target = clickTime;
                                    let best = snapSec;
                                    for (const t of passageTimes) {
                                      const d = Math.abs(t - clickTime);
                                      if (d <= best) { best = d; target = t; }
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
                                  {/* Where the passage the game is showing sits
                                      in the song. A chorus is sung in several
                                      places and the words cannot say which, so
                                      each is marked and the first is filled —
                                      that is the one the lyrics scrolled to.

                                      Pure visual markers now: clicks pass through
                                      to the bar, whose handler snaps a nearby
                                      click to the closest marker. A 10px dot was
                                      its own click target before, but too small
                                      to hit reliably — the snap makes landing near
                                      it enough, so the dots no longer need to
                                      catch the click themselves. */}
                                  {duration > 0 && passageTimes.map((t, i) => (
                                    <div
                                      key={t}
                                      aria-hidden="true"
                                      className={`pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background ${
                                        i === 0 ? "bg-yellow-400" : "bg-yellow-400/50"
                                      }`}
                                      style={{ left: `${Math.min(100, (t / duration) * 100)}%` }}
                                    />
                                  ))}
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
                                {/* A second, not fifteen. The reason to move at
                                    all here is landing on the beat you missed,
                                    and a jump long enough to be useful for
                                    skipping past something is far too long for
                                    that. */}
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

                                {/* 「段落点不准确」— the singer is the only one
                                    who can see the marks against the song; a
                                    tap files the passage into the review queue.
                                    Lives in this wrapping row, not the seek
                                    row: that one cannot wrap, and a button
                                    there narrowed the scrub bar on phones.
                                    Flips to a quiet acknowledgement so it
                                    cannot be spammed from this card. */}
                                {card.lyric && card.mapping?.source && card.mapping?.externalId && (
                                  reportedCards.has(card.eventId) ? (
                                    <span className="shrink-0 text-[0.65rem] text-muted">已反馈，待人工确认</span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setReportedCards((prev) => new Set(prev).add(card.eventId));
                                        // Fire-and-forget: a lost report costs one
                                        // tally, and blocking the singer mid-song
                                        // on a feedback write would be backwards.
                                        mappingAPI.reportPassage({
                                          source: card.mapping.source,
                                          externalId: card.mapping.externalId,
                                          gameLyric: card.lyric,
                                        }).catch(() => {});
                                      }}
                                      className="shrink-0 rounded border border-border px-2 py-1 text-[0.68rem] text-muted hover:border-yellow-500/60 hover:text-yellow-500"
                                    >
                                      段落点不准确
                                    </button>
                                  )
                                )}

                                {/* Pitch and tempo. Pitch appears only once the
                                    track is decoded, which is a second or two
                                    behind the first sound -- offering a control
                                    that silently does nothing would be worse
                                    than making it arrive late. */}
                                {/* Stacked, because each is now a row of
                                    seven: side by side they would read as one
                                    long strip and the labels would stop telling
                                    you which ladder is which. ml-auto while
                                    there is room, and the wrap above drops them
                                    onto their own line when there is not. */}
                                <div className="ml-auto flex flex-col items-end gap-1">
                                  {/* Both rows start at the same x: the label
                                      column is a fixed width, so the two
                                      ladders line up under each other rather
                                      than each beginning wherever its own
                                      label happens to end. */}
                                  <div className="flex items-center gap-1.5">
                                    <span className="w-7 shrink-0 text-right text-[0.62rem] text-muted">变调</span>
                                    {player.canShift ? (
                                      <LivePitchControl pitch={player.pitch} onChange={changePitch} />
                                    ) : (
                                      // Holds the ladder's width while it is
                                      // unavailable, so the tempo row below
                                      // does not shift sideways when it lands.
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

                              {/* Colours and a note, kept per singer.
                                  Below the transport because it is written
                                  between songs rather than during one, and
                                  above the confirmation buttons because those
                                  decide the recording for everybody while
                                  these belong to whoever is signed in. */}
                              <SongPrefEditor
                                prefs={prefs[prefKey(card.mapping)]}
                                onChange={(patch) => changeMarks(card, patch)}
                              />

                              {/* Filled, not outlined. These were a thin border
                                  and dim text on a dark card, which is the one
                                  combination that disappears -- contrast has to
                                  come from the fill, and the judgement being
                                  made here is the whole reason the card opens. */}
                              {/* Confirming is the one mapping decision left
                                  here, and only for a card still awaiting one.
                                  It needs what this page has and the review
                                  page does not: the song was on screen a moment
                                  ago and has just been heard.

                                  Rejecting used to sit beside it and now lives
                                  on the review page. It deletes a recording
                                  from the catalogue -- taking every mapping
                                  that names it, and every singer's saved key --
                                  which is a decision to make with its
                                  consequences in front of you, not mid-round.

                                  Alternative recordings are gone from this page
                                  for the same reason: a card plays one song, so
                                  the key a singer saves while it is open always
                                  belongs to what they were hearing. */}
                              {canApprove && !confirmed && (
                                <div className="mt-2">
                                  <button
                                    type="button"
                                    onClick={() => approve(card)}
                                    disabled={approving}
                                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-40"
                                  >
                                    {approving ? "…" : "✓ 就是这个"}
                                  </button>
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

      {/* Outside the card list on purpose: it belongs to the singer, not to any
          one song, and it has to stay reachable while a card is open — a
          default chosen without hearing it is a guess. */}
      <DefaultTuning
        defaults={defaults}
        onChange={changeDefaults}
        volume={player.volume}
        onVolumeChange={player.setVolume}
        quality={quality}
        onQualityChange={changeQuality}
        vocalsOnly={vocalsOnly}
        onVocalsChange={changeVocalsOnly}
        vocalsAvailable={vocalsAvailable}
      />

      {showAddOnNotice ? (
        // This page is hardcoded Chinese throughout, so the notice is too
        // rather than reaching for the i18n hook it does not use. Same wording
        // as 自动打标's dialog, in 唱卡 terms.
        <ConfirmDialog
          title="此功能属于加订版"
          message="唱卡属于加订版功能（35 元 / 月，含全部加订功能）。请点击 账户 → 套餐与续费 查看详情。"
          confirmLabel="知道了"
          onConfirm={() => setShowAddOnNotice(false)}
          onCancel={() => setShowAddOnNotice(false)}
        />
      ) : null}
    </div>
  );
}
