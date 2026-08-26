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
  // Playback lives in the hook: it starts an <audio> element straight away and
  // decodes in the background, so a card makes sound in well under a second
  // while pitch shifting becomes available a moment later.
  const player = useLivePlayer();
  const { isPlaying: playing, current, duration } = player;
  const [candidates, setCandidates] = useState([]);
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
   * The card asking to be confirmed before its recording is deleted, and what
   * the deletion would take with it.
   *
   * Confirmed in two steps because this is the one irreversible thing on the
   * page: it removes the recording from the catalogue, not just this card's
   * link to it, and a pool track can be named by more than one game song.
   */
  const [rejecting, setRejecting] = useState(null);

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
  /**
   * The alternative currently playing under this card, as {eventId, candidate}.
   *
   * Hearing a version is the whole test, so the confirm button has to commit
   * what is actually sounding rather than what the card still points at —
   * otherwise you listen to B and save A, and the card turns green as if it
   * had worked. It also tells play/pause which recording to toggle: without it
   * the pause button reloads the original mid-audition.
   */
  const [auditioning, setAuditioning] = useState(null);

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
      const res = await captureAPI.liveFeed(sessionId, 60);
      const fresh = res.data.cards || [];
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
      // The feed re-resolves every card, so a mapping may have moved under an
      // audition that is still on screen. Dropping it costs a relabelled button
      // and keeps 就用这个版本 from committing an alternative against whatever
      // the card points at now. The audio is left alone -- only the claim that
      // it is pending a decision goes.
      setAuditioning(null);
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
    // Nothing is sounding, so no version is under audition. Leaving it set
    // would let 就是这个 commit an alternative the user can no longer hear.
    setAuditioning(null);
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
        setAuditioning(override ? { eventId: card.eventId, candidate: override } : null);
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
      // Remember what is sounding, so 就是这个 commits the recording that was
      // heard and play/pause toggles it rather than reloading the original.
      setAuditioning(override ? { eventId: card.eventId, candidate: override } : null);
      await player.load(url);
    } catch (err) {
      setPlayError(err.response?.data?.error?.message || "播放失败");
    } finally {
      setBusy(false);
    }
  }, [player]);

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
    const saved = prefs[prefKey(card.mapping)] || {};
    const wantSpeed = typeof saved.speed === "number" ? saved.speed : 1;
    const wantPitch = typeof saved.pitch === "number" ? saved.pitch : 0;

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
  }, [openId, cards, prefs, prefKey, player.canShift, player.speed, player.pitch,
    player.setSpeed, player.setPitch]);

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
  const toggleCard = useCallback(async (card) => {
    // Before anything else: the card being left owns the key and tempo the
    // player is still holding, and stopAudio does not reset them.
    saveOpenCardSettings();
    stopAudio();
    setPlayError("");
    setCandidates([]);
    // A pending confirmation belongs to the card that raised it. Carrying it to
    // the next one would offer to delete this card's recording under another
    // card's heading.
    setRejecting(null);
    // Likewise the line times: the next card's lyrics are a fetch away, and
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
  }, [openId, stopAudio, playCard, setLineTimes, saveOpenCardSettings]);

  /**
   * Play or pause whatever this card is currently sounding.
   *
   * Plain `playCard(card)` names the card's own recording, so during an
   * audition it misses the loaded key and fetches the original instead of
   * pausing. The transport and the spacebar both go through here.
   */
  const togglePlayback = useCallback((card) => {
    const cand = auditioning?.eventId === card.eventId ? auditioning.candidate : null;
    playCard(card, cand ? { source: cand.source, externalId: cand.externalId } : undefined);
  }, [auditioning, playCard]);

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
   * Switch to another version and play it immediately — hearing it is the test.
   *
   * The whole candidate travels, not just its ids: confirming later rewrites
   * the card from it, and a title stripped here would blank the card's heading.
   */
  const tryCandidate = useCallback((card, cand) => {
    stopAudio();
    playCard(card, cand);
  }, [stopAudio, playCard]);

  /**
   * Confirm the mapping. Takes effect everywhere at once, which is the point:
   * the next person to meet this song gets the version just verified by ear.
   *
   * `explicit` names a version outright; otherwise this commits whatever is
   * being auditioned, so the button always agrees with the audio. Sending the
   * card's own track while an alternative plays is the mistake this guards.
   */
  const approve = useCallback(async (card, explicit) => {
    // The buttons are already hidden; this is the same answer stated where the
    // work would start, so a stale handle or a future caller cannot reach it.
    if (!canApprove || !card.mapping) return;
    const cand = explicit
      || (auditioning?.eventId === card.eventId ? auditioning.candidate : null);
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
      // The audition is over: what was an alternative is now the card's own
      // recording. Leaving it set would keep the button reading 就用这个版本
      // and keep the ▶ mark on a row that is no longer an alternative at all.
      //
      // The loaded key has to move with it. It still names the audition
      // (`event:QQ:123`) while play/pause now asks for the card's own track
      // (`event`), and a key that misses re-downloads the song instead of
      // pausing it. Same audio either way — only its name here changes.
      if (cand) {
        if (loadedFor.current === `${card.eventId}:${cand.source}:${cand.externalId}`) {
          loadedFor.current = card.eventId;
        }
        setAuditioning(null);
      }
    } catch (err) {
      // A 403 means this account simply lacks the flag. Say so once and stop
      // offering the button rather than failing every time it is pressed.
      if (err.response?.status === 403) { refused.current = true; setCanApprove(false); }
      else setPlayError(err.response?.data?.error?.message || "确认失败");
    } finally {
      setApproving(false);
    }
  }, [auditioning, canApprove]);

  /**
   * Ask what deleting this recording would take with it, then show the
   * confirmation.
   *
   * The impact is read from the server rather than guessed: a pool track is
   * keyed on (source, id) and nothing stops two game songs naming the same one,
   * so the count is not visible from the card.
   */
  const startReject = useCallback(async (card) => {
    if (!canApprove || !card.mapping) return;
    if (rejecting?.eventId === card.eventId) { setRejecting(null); return; }
    setApproving(true);
    setPlayError("");
    try {
      const res = await mappingAPI.rejectImpact(card.mapping.mappingId);
      setRejecting({ eventId: card.eventId, ...res.data });
    } catch (err) {
      if (err.response?.status === 403) { refused.current = true; setCanApprove(false); }
      else setPlayError(err.response?.data?.error?.message || "读取删除影响失败");
    } finally {
      setApproving(false);
    }
  }, [rejecting, canApprove]);

  /**
   * Delete the recording, and take whatever the resolver offers next.
   *
   * The card stays on screen. It records what the game showed, which is still
   * true — only what it plays changes, to the next recording of the same song
   * or to nothing at all when the catalogue has no other.
   */
  const confirmReject = useCallback(async (card) => {
    if (!canApprove || !card.mapping) return;
    setApproving(true);
    setPlayError("");
    try {
      const res = await mappingAPI.reject(card.mapping.mappingId, { deleteTrack: true });
      const next = res.data.replacement;
      // Whatever was playing is the recording that was just deleted.
      stopAudio();
      setCards((prev) => prev.map((c) => (c.eventId === card.eventId
        ? {
          ...c,
          mapping: next
            ? {
              mappingId: next.id,
              source: next.source,
              externalId: next.externalId,
              title: next.platformTitle,
              artist: next.platformArtist,
              durationSec: next.durationSec,
              approved: next.approved,
            }
            : null,
        }
        : c)));
      // The alternatives on screen came from the pool this just changed.
      setCandidates([]);
      setRejecting(null);
      if (next) {
        try {
          const c2 = await mappingAPI.candidates(next.id);
          setCandidates(c2.data.candidates || c2.data || []);
        } catch { /* the card still plays; alternatives are a convenience */ }
      } else {
        // Nothing left to play, so the panel unmounts — it renders only for a
        // mapped card. Letting `openId` keep naming it would make the next tap
        // read as "close", so the card would need two taps to open again.
        setOpenId(null);
      }
    } catch (err) {
      if (err.response?.status === 403) { refused.current = true; setCanApprove(false); }
      else setPlayError(err.response?.data?.error?.message || "删除失败");
    } finally {
      setApproving(false);
    }
  }, [stopAudio, canApprove]);

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

  // The add-on is the gate. Checked here as well as in the nav because the URL
  // is guessable, though this only saves a wasted trip -- every route the page
  // calls is gated on the server too.
  if (!canCapture) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <h1 className="mb-2 text-lg font-medium">唱卡</h1>
        <p className="text-sm text-muted">唱卡是加订版功能，开通后即可使用。</p>
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
                            {/* The singer's own marks, before the status
                                badge: a note and colours are theirs, and the
                                badge is the site's judgement of the recording.
                                Renders nothing when the song has never been
                                marked, so an untouched card is unchanged. */}
                            {mapped ? <SongPrefMarks prefs={prefs[prefKey(card.mapping)]} /> : null}
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
                                  override={auditioning?.eventId === card.eventId
                                    ? auditioning.candidate : null}
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
                                    if (duration > 0) {
                                      player.seek(((e.clientX - r.left) / r.width) * duration);
                                    }
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

                                      Each stops the click reaching the bar
                                      underneath, which would seek to wherever
                                      the pointer happened to land rather than
                                      to the passage itself. */}
                                  {duration > 0 && passageTimes.map((t, i) => (
                                    <button
                                      key={t}
                                      type="button"
                                      title={`跳到这段 ${formatClock(t)}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        player.seek(t);
                                      }}
                                      className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background transition-transform hover:scale-125 ${
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

                              <div className="mt-2 flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => togglePlayback(card)}
                                  disabled={busy}
                                  className="h-8 w-8 shrink-0 rounded-full border border-border text-xs hover:border-accent disabled:opacity-30"
                                >
                                  {busy ? "…" : playing ? "❚❚" : "▶"}
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

                                {/* Pitch and tempo. Pitch appears only once the
                                    track is decoded, which is a second or two
                                    behind the first sound -- offering a control
                                    that silently does nothing would be worse
                                    than making it arrive late. */}
                                {/* Stacked, and the two rows are the same three
                                    buttons in the same places: down, back to
                                    normal, up. Side by side they read as one
                                    long strip of controls and the labels stop
                                    telling you which is which. */}
                                <div className="ml-auto flex flex-col items-end gap-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="w-6 shrink-0 text-right text-[0.65rem] text-muted">变调</span>
                                    {player.canShift ? (
                                      <LivePitchControl pitch={player.pitch} onChange={changePitch} />
                                    ) : (
                                      <span className="text-[0.65rem] text-muted/60">准备中…</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    <span className="w-6 shrink-0 text-right text-[0.65rem] text-muted">变速</span>
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
                              {canApprove && (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {/* Offered on confirmed cards too, but only
                                      while an alternative is playing. A match on
                                      title and artist confirms itself, so the
                                      wrong version arrives already green, and
                                      requiring an 撤销 first would make fixing it
                                      a detour. */}
                                  {(!confirmed || auditioning?.eventId === card.eventId) && (
                                    <button
                                      type="button"
                                      onClick={() => approve(card)}
                                      disabled={approving}
                                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-40"
                                    >
                                      {/* Says which one it would save. Sending
                                          the card's own track while an
                                          alternative plays is the mistake this
                                          wording guards against. */}
                                      {approving
                                        ? "…"
                                        : auditioning?.eventId === card.eventId
                                          ? "✓ 就用这个版本"
                                          : "✓ 就是这个"}
                                    </button>
                                  )}
                                  {/* Offered on confirmed cards too. A song that
                                      matched on title and artist approves itself,
                                      which is exactly when several recordings
                                      carry the same billing — so the wrong one
                                      arrives already confirmed, and this is where
                                      it gets noticed. */}
                                  <button
                                    type="button"
                                    onClick={() => startReject(card)}
                                    disabled={approving}
                                    className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-red-500 disabled:opacity-40"
                                  >
                                    ✕ 不是这首
                                  </button>
                                </div>
                              )}

                              {/* `canApprove` as well as the panel's own flag.
                                  It was reachable only through the guarded
                                  button above, which made it safe by where it
                                  could be opened from rather than by what it
                                  checks -- and the flag can now go false while
                                  it is open, which would leave 确认删除 alone
                                  on screen with its siblings gone. */}
                              {canApprove && rejecting?.eventId === card.eventId && (
                                <div className="mt-2 rounded border border-red-500/30 bg-red-500/5 p-2">
                                  <p className="text-[0.7rem] text-red-200">
                                    从曲库彻底删除
                                    <span className="mx-1 font-medium">
                                      {rejecting.track
                                        ? `${rejecting.track.title} — ${rejecting.track.artist}`
                                        : "（曲库里已无此条目）"}
                                    </span>
                                    ？
                                  </p>
                                  {rejecting.otherMappings?.length > 0 && (
                                    <p className="mt-1 text-[0.68rem] text-amber-300">
                                      ⚠ 另有 {rejecting.otherMappings.length} 条映射指向同一首，会一并删除
                                    </p>
                                  )}
                                  <p className="mt-1 text-[0.68rem] text-muted">
                                    删除后会自动改用曲库里的其他版本；没有其他版本就显示未配置。
                                  </p>
                                  <div className="mt-1.5 flex gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => confirmReject(card)}
                                      disabled={approving}
                                      className="rounded-md bg-red-600 px-3 py-1.5 text-[0.72rem] font-semibold text-white shadow-sm hover:bg-red-500 disabled:opacity-40"
                                    >
                                      {approving ? "删除中…" : "确认删除"}
                                    </button>
                                    {/* Disabled once the delete is away: the
                                        request cannot be recalled, and closing
                                        the panel would read as "cancelled"
                                        while it lands anyway. */}
                                    <button
                                      type="button"
                                      onClick={() => setRejecting(null)}
                                      disabled={approving}
                                      className="rounded border border-border px-2 py-1 text-[0.7rem] text-muted disabled:opacity-40"
                                    >
                                      取消
                                    </button>
                                  </div>
                                </div>
                              )}

                              {candidates.length > 1 && (
                                <div className="mt-3 border-t border-border/40 pt-2">
                                  <div className="mb-1 text-[0.68rem] text-muted">其他版本</div>
                                  <ul className="space-y-1">
                                    {candidates
                                      // Both halves: an id alone is only unique
                                      // within its own platform.
                                      .filter((c) => !(c.source === card.mapping.source
                                        && c.externalId === card.mapping.externalId))
                                      .slice(0, 5)
                                      .map((c) => {
                                        // Which one is sounding. Every row reads
                                        // the same once the audio moves on, so
                                        // without this the list gives no sign of
                                        // what 就用这个版本 would save.
                                        const isPlaying = auditioning?.eventId === card.eventId
                                          && auditioning.candidate.source === c.source
                                          && auditioning.candidate.externalId === c.externalId;
                                        return (
                                          <li key={`${c.source}:${c.externalId}`} className="flex items-center gap-2">
                                            <button
                                              type="button"
                                              onClick={() => tryCandidate(card, c)}
                                              className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-xs hover:bg-white/5 hover:text-fg ${
                                                isPlaying ? "bg-white/5 text-fg" : "text-muted"
                                              }`}
                                            >
                                              {isPlaying ? "▶ " : ""}
                                              {c.title} · {c.artist} · {formatDuration(c.durationSec)}
                                              {" · "}{SOURCE_LABEL[c.source] || c.source}
                                            </button>
                                          </li>
                                        );
                                      })}
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
