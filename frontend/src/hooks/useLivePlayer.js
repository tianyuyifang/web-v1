"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Player for 唱卡 cards, which play a URL rather than a clip from our library.
 *
 * Two stages, because the two things wanted here are in tension. A singer opens
 * a card because their turn is coming, so sound has to start in well under a
 * second; but shifting pitch needs the whole file decoded first, which costs a
 * second or two on a 3 MB track. Waiting for the decode before playing anything
 * would make the common case worse to serve the rarer one.
 *
 * So an <audio> element starts immediately, and the decode runs behind it. Once
 * it lands, pitch becomes available and switching to it resumes from the same
 * position. A listener who never touches pitch never pays for it.
 *
 * useAudioPlayer is not reused: it is built around clipId and our own cached
 * buffers, and everything here comes from a platform CDN.
 */
export default function useLivePlayer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeedState] = useState(1);
  const [pitch, setPitchState] = useState(0);
  const [volume, setVolumeState] = useState(1);
  /**
   * The same two values, readable synchronously.
   *
   * `setSpeedState` does not change `speed` until the next render, so anything
   * that reads the state variable is reading what it was BEFORE the caller
   * asked for a change. That is fine for rendering and wrong for the audio:
   * `load` assigns el.playbackRate and `startShifted` seeds the graph, and
   * both ran with the previous value whenever a load and a change landed in
   * the same tick -- which is exactly what happens when a card opens and its
   * remembered settings are applied a moment later. The control showed the new
   * number while the track played at the old one.
   *
   * Refs update in place, so the audio path reads what was actually asked for.
   * The state variables stay, because rendering must go through them.
   */
  const speedRef = useRef(1);
  const pitchRef = useRef(0);
  /**
   * Output level, 0 to 1.
   *
   * A ref for the same reason as the two above -- `load` reads it while
   * starting a track, which can happen before a state change has rendered --
   * and state as well, because the slider renders from it.
   *
   * It has to reach two different places. Without a shift the sound comes from
   * the <audio> element, which has its own `volume`; with one it comes through
   * the SoundTouch graph, where the gain node is the only handle. Setting just
   * one of them would make the control work until someone changed key.
   */
  const volumeRef = useRef(1);
  /** True once the buffer is decoded and pitch can actually be applied. */
  const [canShift, setCanShift] = useState(false);

  const elRef = useRef(null);
  const urlRef = useRef(null);

  const ctxRef = useRef(null);
  const bufferRef = useRef(null);
  const shifterRef = useRef(null);
  const gainRef = useRef(null);
  /** Where the shifted graph started, so position survives a rebuild. */
  const offsetRef = useRef(0);
  const startedAtRef = useRef(0);
  const decodeForRef = useRef(null);
  /** True while the SoundTouch graph is the one making sound. */
  const shiftingRef = useRef(false);
  /**
   * The graph that plays only the first two channels, and whether it is on.
   *
   * QQ's separated track is one file with four channels: the voice in 0 and 1,
   * the backing in 2 and 3. An <audio> element downmixes all four, so the
   * "vocals only" setting did nothing there — the backing came through with
   * the voice. Web Audio can take the first pair alone, which is what this is.
   *
   * The shifted path needed no equivalent: SoundTouch reads channels 0 and 1
   * and ignores the rest, which is why shifting the key already sounded right
   * and not shifting it did not.
   */
  const vocalsSrcRef = useRef(null);
  const vocalsOnRef = useRef(false);
  const wantVocalsRef = useRef(false);
  /** Set when a decode finishes and a vocals request is waiting on it. */
  const pendingVocalsRef = useRef(false);
  const rafRef = useRef(0);

  /**
   * Wire an element to the clock and the ended signal.
   *
   * Separate from creating one, because swapping to a different file of the
   * same song replaces the element: the new one needs the same listeners, and
   * defining them twice is how the two drift apart.
   */
  const attachElementListeners = useCallback((el) => {
    const sync = () => {
      // A Web Audio graph owns the clock while one is playing.
      if (shiftingRef.current || vocalsOnRef.current) return;
      setCurrent(el.currentTime || 0);
      setDuration(el.duration || 0);
    };
    el.addEventListener("timeupdate", sync);
    el.addEventListener("loadedmetadata", sync);
    el.addEventListener("ended", () => setIsPlaying(false));
    return el;
  }, []);

  const element = useCallback(() => {
    if (elRef.current) return elRef.current;
    const el = new Audio();
    el.preload = "metadata";
    el.crossOrigin = "anonymous";
    attachElementListeners(el);
    elRef.current = el;
    return el;
  }, [attachElementListeners]);

  /** Position in the track, wherever the sound is coming from. */
  const positionNow = useCallback(() => {
    if ((shiftingRef.current || vocalsOnRef.current) && ctxRef.current) {
      const elapsed = (ctxRef.current.currentTime - startedAtRef.current) * speedRef.current;
      return Math.min(offsetRef.current + elapsed, duration || Infinity);
    }
    return elRef.current ? elRef.current.currentTime || 0 : 0;
  }, [duration]);

  /**
   * The playhead, once per frame.
   *
   * The shifted graph reports no timeupdate events at all, so it has always
   * needed this. The <audio> element does report them, but only about four
   * times a second — fine for a clock reading and far too coarse for the
   * karaoke sweep, which would advance in visible steps rather than moving.
   * Reading currentTime once a frame costs nothing and makes both paths smooth.
   */
  useEffect(() => {
    if (!isPlaying) return undefined;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      if (shiftingRef.current || vocalsOnRef.current) setCurrent(positionNow());
      else if (elRef.current) setCurrent(elRef.current.currentTime || 0);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(rafRef.current); };
  }, [isPlaying, positionNow]);

  /** Stop whichever Web Audio graph is playing, leaving the element alone. */
  const teardownGraph = useCallback(() => {
    if (shifterRef.current) {
      try { shifterRef.current.disconnect(); } catch { /* already gone */ }
      shifterRef.current = null;
    }
    shiftingRef.current = false;
    if (vocalsSrcRef.current) {
      try { vocalsSrcRef.current.stop(); } catch { /* not started */ }
      try { vocalsSrcRef.current.disconnect(); } catch { /* already gone */ }
      vocalsSrcRef.current = null;
    }
    vocalsOnRef.current = false;
  }, []);

  /**
   * Fetch and decode in the background so pitch can be offered later.
   *
   * Failure is silent on purpose: the track is already playing through the
   * element, and the only thing lost is the pitch control, which is announced
   * by leaving it hidden rather than by an error the listener cannot act on.
   */
  const warmBuffer = useCallback(async (url) => {
    if (decodeForRef.current === url) return;
    decodeForRef.current = url;
    setCanShift(false);
    bufferRef.current = null;
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) return;
      const raw = await res.arrayBuffer();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!ctxRef.current) ctxRef.current = new Ctx();
      const buf = await ctxRef.current.decodeAudioData(raw);
      // A later card may have been opened while this was decoding.
      if (decodeForRef.current !== url) return;
      bufferRef.current = buf;
      if (!duration) setDuration(buf.duration);
      setCanShift(true);
      // The wait is over for a vocals request made while this was decoding.
      // Nothing to do if a shift is already playing: that path takes channels
      // 0 and 1 by itself.
      if (wantVocalsRef.current && !shiftingRef.current && !vocalsOnRef.current
        && elRef.current && !elRef.current.paused) {
        pendingVocalsRef.current = true;
      }
    } catch {
      // CORS refused, or a codec the browser will not decode. Plain playback
      // still works; pitch simply stays unavailable for this track.
    }
  }, [duration]);

  /**
   * Play the decoded buffer's first two channels and nothing else.
   *
   * Only useful for QQ's separated track, where those two carry the voice.
   * On an ordinary stereo file it is the file itself, so this is only ever
   * started when the caller has asked for vocals.
   *
   * Needs the whole track decoded, which is the same wait pitch shifting has
   * and for the same reason. The element keeps playing until then, so what the
   * singer hears is the backing dropping away a second or two in rather than
   * silence at the start.
   */
  const startVocalsOnly = useCallback(async (from) => {
    const buf = bufferRef.current;
    const ctx = ctxRef.current;
    if (!buf || !ctx) return false;
    if (ctx.state === "suspended") await ctx.resume();

    teardownGraph();

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speedRef.current;

    if (!gainRef.current) {
      gainRef.current = ctx.createGain();
      gainRef.current.connect(ctx.destination);
    }
    gainRef.current.gain.value = volumeRef.current;

    if (buf.numberOfChannels > 2) {
      // Split, then take 0 and 1 and nothing else. Merging them back to a
      // stereo pair rather than connecting the splitter straight to the gain,
      // which would sum every channel and put the backing right back.
      const splitter = ctx.createChannelSplitter(buf.numberOfChannels);
      const merger = ctx.createChannelMerger(2);
      src.connect(splitter);
      splitter.connect(merger, 0, 0);
      splitter.connect(merger, 1, 1);
      merger.connect(gainRef.current);
    } else {
      // Two channels already — nothing to separate, and connecting a splitter
      // here would be a pointless detour.
      src.connect(gainRef.current);
    }

    src.onended = () => {
      // Only when it truly ran out; a stop() during teardown clears the ref
      // first, so this cannot fire for a graph being replaced.
      if (vocalsSrcRef.current === src) setIsPlaying(false);
    };

    src.start(0, Math.max(0, Math.min(from || 0, buf.duration - 0.01)));
    vocalsSrcRef.current = src;
    vocalsOnRef.current = true;
    offsetRef.current = from || 0;
    startedAtRef.current = ctx.currentTime;
    return true;
  }, [teardownGraph]);

  /** Build the SoundTouch graph and start it at `from`. */
  const startShifted = useCallback(async (from) => {
    const buf = bufferRef.current;
    const ctx = ctxRef.current;
    if (!buf || !ctx) return false;
    if (ctx.state === "suspended") await ctx.resume();

    const { PitchShifter } = await import(
      /* webpackChunkName: "soundtouchjs" */ "soundtouchjs"
    );
    teardownGraph();

    const shifter = new PitchShifter(ctx, buf, 4096, () => setIsPlaying(false));
    shifter.tempo = speedRef.current;
    shifter.pitchSemitones = pitchRef.current;
    shifter.percentagePlayed = Math.min(0.999, (from || 0) / buf.duration);

    if (!gainRef.current) {
      gainRef.current = ctx.createGain();
      gainRef.current.connect(ctx.destination);
    }
    // Built fresh on every shift, so it has to be told the level rather than
    // inheriting the 1.0 a new node starts at.
    gainRef.current.gain.value = volumeRef.current;
    shifter.connect(gainRef.current);

    shifterRef.current = shifter;
    offsetRef.current = from || 0;
    startedAtRef.current = ctx.currentTime;
    shiftingRef.current = true;
    return true;
    // speed and pitch are read from refs above, so this stays stable across a
    // tempo change instead of being rebuilt -- and a rebuild here restarts the
    // graph, which is audible.
  }, [teardownGraph]);

  /**
   * Change to a different file of the same song without a gap.
   *
   * Switching between the full mix and the vocals-only track, or between
   * quality tiers, means a different URL for audio the singer is already in the
   * middle of. Assigning it to the playing element would stop the sound, show a
   * spinner and start again from wherever the buffer got to — a second of
   * silence in the middle of a line.
   *
   * So a second element loads the new file quietly, seeks to where the first
   * one is, and only then takes over. The swap happens on a frame where both
   * are ready, so what the singer hears is the same music continuing.
   *
   * Falls back to a plain load if the new file will not play: better a gap
   * than nothing.
   */
  const swapSource = useCallback(async (url) => {
    const el = element();
    if (!url || url === urlRef.current) return true;

    // Nothing playing yet — there is no continuity to preserve.
    if (!el.src || el.paused) {
      urlRef.current = url;
      el.src = url;
      el.playbackRate = speedRef.current;
      el.volume = volumeRef.current;
      warmBuffer(url);
      return true;
    }

    const at = shiftingRef.current ? positionNow() : (el.currentTime || 0);
    const wasShifting = shiftingRef.current;

    const next = new Audio();
    next.preload = "auto";
    next.crossOrigin = "anonymous";
    next.src = url;
    next.volume = volumeRef.current;
    next.playbackRate = speedRef.current;

    const ready = await new Promise((resolve) => {
      let settled = false;
      const done = (okay) => { if (!settled) { settled = true; resolve(okay); } };
      // canplay rather than canplaythrough: enough to start, without waiting
      // for the whole file — which for a 23MB vocals track is most of a minute.
      next.addEventListener("canplay", () => done(true), { once: true });
      next.addEventListener("error", () => done(false), { once: true });
      // A cap, so a stalled CDN leaves the current audio playing rather than
      // hanging the control that asked for the change.
      setTimeout(() => done(false), 8000);
      try { next.currentTime = at; } catch { /* set again below once seekable */ }
      next.load();
    });

    if (!ready) { next.src = ""; return false; }

    try { next.currentTime = at; } catch { /* streams that refuse a seek */ }
    await next.play().catch(() => {});

    // Hand over: the old element stops only once the new one is making sound.
    const old = elRef.current;
    elRef.current = next;
    urlRef.current = url;
    attachElementListeners(next);
    if (old) { old.pause(); old.src = ""; }

    // The decoded buffer belonged to the previous file.
    teardownGraph();
    decodeForRef.current = null;
    bufferRef.current = null;
    setCanShift(false);
    warmBuffer(url);

    // A shifted key was in force, and the graph it used is gone. It comes back
    // when the new file finishes decoding, through the page's own effect.
    if (wasShifting) shiftingRef.current = false;
    setIsPlaying(true);
    return true;
  }, [element, positionNow, teardownGraph, warmBuffer, attachElementListeners]);

  /** Load a URL and start playing it through the element. */
  const load = useCallback(async (url) => {
    const el = element();
    teardownGraph();
    urlRef.current = url;
    el.src = url;
    setCurrent(0);
    setDuration(0);
    el.playbackRate = speedRef.current;
    el.volume = volumeRef.current;
    await el.play();
    setIsPlaying(true);
    // Deliberately not awaited: the point is that sound has already started.
    warmBuffer(url);
  }, [element, teardownGraph, warmBuffer]);

  const toggle = useCallback(async () => {
    const el = element();
    if (isPlaying) {
      if (shiftingRef.current || vocalsOnRef.current) {
        offsetRef.current = positionNow();
        teardownGraph();
        el.currentTime = offsetRef.current;
      } else {
        el.pause();
      }
      setIsPlaying(false);
      return;
    }
    // The ref, not the state: this decides WHICH engine resumes, so reading a
    // value one render behind would start the plain element for a track that
    // is meant to be shifted.
    if (pitchRef.current !== 0 && bufferRef.current) {
      if (await startShifted(positionNow())) { setIsPlaying(true); return; }
    }
    // Vocals with no shift: its own graph, since the element would downmix
    // the backing channels back in.
    if (wantVocalsRef.current && bufferRef.current) {
      if (await startVocalsOnly(positionNow())) { setIsPlaying(true); return; }
    }
    await el.play().catch(() => {});
    setIsPlaying(true);
  }, [element, isPlaying, positionNow, startShifted, startVocalsOnly, teardownGraph]);

  const seek = useCallback(async (seconds) => {
    const at = Math.max(0, seconds);
    const el = element();
    if (shiftingRef.current) {
      await startShifted(at);
      setCurrent(at);
      return;
    }
    // A buffer source cannot be moved; seeking means building a new one.
    if (vocalsOnRef.current) {
      await startVocalsOnly(at);
      setCurrent(at);
      return;
    }
    el.currentTime = at;
    setCurrent(at);
  }, [element, startShifted, startVocalsOnly]);

  /**
   * Pitch is what forces the switch between the two engines: an <audio>
   * element cannot do it at all, so asking for any shift moves playback onto
   * the decoded graph, and returning to zero moves it back.
   */
  const setPitch = useCallback(async (value) => {
    const next = Math.max(-6, Math.min(6, value));
    // Ref first: everything below, and anything that runs before the next
    // render, has to see the value being asked for rather than the last one.
    pitchRef.current = next;
    setPitchState(next);

    if (shifterRef.current) {
      if (next === 0) {
        const at = positionNow();
        teardownGraph();
        // Vocals-only has to be honoured on the way back down. The element
        // downmixes all four channels, so handing playback to it here would
        // quietly bring the backing track back — the setting would appear to
        // switch itself off whenever someone returned to the original key.
        if (wantVocalsRef.current && bufferRef.current && isPlaying) {
          if (await startVocalsOnly(at)) return;
        }
        // Otherwise the element, which is cheaper and seeks instantly.
        const el = element();
        el.currentTime = at;
        if (isPlaying) await el.play().catch(() => {});
        return;
      }
      shifterRef.current.pitchSemitones = next;
      return;
    }
    if (next !== 0 && bufferRef.current && isPlaying) {
      const at = positionNow();
      element().pause();
      await startShifted(at);
    }
  }, [element, isPlaying, positionNow, startShifted, startVocalsOnly, teardownGraph]);

  /**
   * Set the output level, on whichever engine is currently sounding.
   *
   * Both are written every time rather than only the active one: the other may
   * take over mid-song -- asking for a shifted key builds the graph, returning
   * to the original hands playback back to the element -- and a level applied
   * to only one of them would be lost at that moment.
   */
  const setVolume = useCallback((value) => {
    const next = Math.max(0, Math.min(1, value));
    volumeRef.current = next;
    setVolumeState(next);
    if (elRef.current) elRef.current.volume = next;
    if (gainRef.current) gainRef.current.gain.value = next;
  }, []);

  /**
   * Play only the voice, once the decode makes that possible.
   *
   * Asked for rather than done immediately: separating channels needs the
   * whole track decoded, which lands a second or two after the first sound.
   * Until then the element keeps playing the full mix, so the singer hears the
   * backing drop away rather than a silence at the start — the same trade the
   * pitch control already makes, and for the same reason.
   *
   * Turning it off hands playback back to the element at the same position.
   */
  const setVocalsOnly = useCallback(async (on) => {
    wantVocalsRef.current = !!on;

    if (!on) {
      if (!vocalsOnRef.current) return;
      const at = positionNow();
      teardownGraph();
      const el = element();
      el.currentTime = at;
      el.volume = volumeRef.current;
      el.playbackRate = speedRef.current;
      if (isPlaying) await el.play().catch(() => {});
      return;
    }

    // Shifting already plays channels 0 and 1 alone, so there is nothing to
    // do while it is in force.
    if (shiftingRef.current) return;
    if (!bufferRef.current || !isPlaying) return;

    const at = positionNow();
    element().pause();
    await startVocalsOnly(at);
  }, [element, isPlaying, positionNow, startVocalsOnly, teardownGraph]);

  const setSpeed = useCallback((value) => {
    const next = Math.max(0.5, Math.min(2, value));
    speedRef.current = next;
    setSpeedState(next);
    if (shifterRef.current) shifterRef.current.tempo = next;
    else if (elRef.current) elRef.current.playbackRate = next;
  }, []);

  const stop = useCallback(() => {
    teardownGraph();
    if (elRef.current) {
      elRef.current.pause();
      elRef.current.src = "";
    }
    decodeForRef.current = null;
    bufferRef.current = null;
    // Cleared with the rest: a request left standing would have the next card
    // start in vocals mode without the page having asked for it.
    pendingVocalsRef.current = false;
    setCanShift(false);
    setIsPlaying(false);
    setCurrent(0);
    setDuration(0);
  }, [teardownGraph]);

  useEffect(() => () => {
    teardownGraph();
    if (elRef.current) elRef.current.pause();
    if (ctxRef.current) ctxRef.current.close().catch(() => {});
  }, [teardownGraph]);

  return {
    load, toggle, seek, stop, swapSource,
    setPitch, setSpeed, setVolume, setVocalsOnly,
    isPlaying, current, duration, pitch, speed, volume, canShift,
  };
}
