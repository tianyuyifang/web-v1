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
  const rafRef = useRef(0);

  const element = useCallback(() => {
    if (elRef.current) return elRef.current;
    const el = new Audio();
    el.preload = "metadata";
    el.crossOrigin = "anonymous";
    const sync = () => {
      if (shiftingRef.current) return; // the graph owns the clock now
      setCurrent(el.currentTime || 0);
      setDuration(el.duration || 0);
    };
    el.addEventListener("timeupdate", sync);
    el.addEventListener("loadedmetadata", sync);
    el.addEventListener("ended", () => setIsPlaying(false));
    elRef.current = el;
    return el;
  }, []);

  /** Position in the track, wherever the sound is coming from. */
  const positionNow = useCallback(() => {
    if (shiftingRef.current && ctxRef.current) {
      const elapsed = (ctxRef.current.currentTime - startedAtRef.current) * speed;
      return Math.min(offsetRef.current + elapsed, duration || Infinity);
    }
    return elRef.current ? elRef.current.currentTime || 0 : 0;
  }, [speed, duration]);

  // The shifted graph reports no timeupdate events, so drive the clock here.
  useEffect(() => {
    if (!isPlaying) return undefined;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      if (shiftingRef.current) setCurrent(positionNow());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(rafRef.current); };
  }, [isPlaying, positionNow]);

  const teardownGraph = useCallback(() => {
    if (shifterRef.current) {
      try { shifterRef.current.disconnect(); } catch { /* already gone */ }
      shifterRef.current = null;
    }
    shiftingRef.current = false;
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
    } catch {
      // CORS refused, or a codec the browser will not decode. Plain playback
      // still works; pitch simply stays unavailable for this track.
    }
  }, [duration]);

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
    shifter.tempo = speed;
    shifter.pitchSemitones = pitch;
    shifter.percentagePlayed = Math.min(0.999, (from || 0) / buf.duration);

    if (!gainRef.current) {
      gainRef.current = ctx.createGain();
      gainRef.current.connect(ctx.destination);
    }
    shifter.connect(gainRef.current);

    shifterRef.current = shifter;
    offsetRef.current = from || 0;
    startedAtRef.current = ctx.currentTime;
    shiftingRef.current = true;
    return true;
  }, [speed, pitch, teardownGraph]);

  /** Load a URL and start playing it through the element. */
  const load = useCallback(async (url) => {
    const el = element();
    teardownGraph();
    urlRef.current = url;
    el.src = url;
    setCurrent(0);
    setDuration(0);
    el.playbackRate = speed;
    await el.play();
    setIsPlaying(true);
    // Deliberately not awaited: the point is that sound has already started.
    warmBuffer(url);
  }, [element, speed, teardownGraph, warmBuffer]);

  const toggle = useCallback(async () => {
    const el = element();
    if (isPlaying) {
      if (shiftingRef.current) {
        offsetRef.current = positionNow();
        teardownGraph();
        el.currentTime = offsetRef.current;
      } else {
        el.pause();
      }
      setIsPlaying(false);
      return;
    }
    if (pitch !== 0 && bufferRef.current) {
      if (await startShifted(positionNow())) { setIsPlaying(true); return; }
    }
    await el.play().catch(() => {});
    setIsPlaying(true);
  }, [element, isPlaying, pitch, positionNow, startShifted, teardownGraph]);

  const seek = useCallback(async (seconds) => {
    const at = Math.max(0, seconds);
    const el = element();
    if (shiftingRef.current) {
      await startShifted(at);
      setCurrent(at);
      return;
    }
    el.currentTime = at;
    setCurrent(at);
  }, [element, startShifted]);

  /**
   * Pitch is what forces the switch between the two engines: an <audio>
   * element cannot do it at all, so asking for any shift moves playback onto
   * the decoded graph, and returning to zero moves it back.
   */
  const setPitch = useCallback(async (value) => {
    const next = Math.max(-6, Math.min(6, value));
    setPitchState(next);

    if (shifterRef.current) {
      if (next === 0) {
        // Back to the element, which is cheaper and seeks instantly.
        const at = positionNow();
        teardownGraph();
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
  }, [element, isPlaying, positionNow, startShifted, teardownGraph]);

  const setSpeed = useCallback((value) => {
    const next = Math.max(0.5, Math.min(2, value));
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
    load, toggle, seek, stop,
    setPitch, setSpeed,
    isPlaying, current, duration, pitch, speed, canShift,
  };
}
