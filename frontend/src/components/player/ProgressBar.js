"use client";

import { useRef, useCallback, useEffect, memo } from "react";

const pctOf = (time, duration) => (duration ? Math.min((time / duration) * 100, 100) : 0);

// How far (seconds of clip time) the moving bar may be from the real position
// before it is restarted from the real one. 0.08 s is about 1 px of the bar.
const RESYNC_TOLERANCE = 0.08;
// The audio clock counts as stalled once it has not moved for this long (ms).
// Some outputs report it in steps of ~100 ms; those are not stalls.
const STALL_MS = 250;
// An animation is checked against its own clock once it has run this long (ms),
// and must be within this much (ms) of the time since it was started.
const ANIMATION_SETTLE_MS = 500;
const ANIMATION_SLACK_MS = 250;

const THUMB_CLASS =
  "absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-sm transition-transform hover:scale-125";
const THUMB_STYLE = {
  border: "2.5px solid var(--surface)",
  boxShadow: "0 0 0 1px rgba(var(--primary-rgb, 91,82,212), 0.2), 0 1px 3px rgba(0,0,0,0.12)",
};

/**
 * The position comes from timeSource (see useAudioPlayer), not from a prop.
 *
 * It used to be a prop that changed every frame while a clip played: React set
 * the fill's width and the thumb's left 60 times a second, and each time the
 * browser re-did layout, hover hit-testing and paint for the whole playlist
 * page (~13 ms a frame with 419 cards) on the thread that also produces the
 * sound — on a slower computer the sound broke up.
 *
 * Now the bar has two forms:
 *  - Still: the same two elements as before, sized with width / left, so it
 *    looks exactly as it did. Used whenever the clip is not advancing, and
 *    also while the pointer is over the bar — then it is updated on every tick
 *    like the old bar, so hovering, clicking and dragging meet the very same
 *    elements, and the thumb's hover state follows it as it always did.
 *  - Moving (playing, pointer elsewhere): a second pair, moved by a transform
 *    animation from the current position to the end over the time left. The
 *    browser runs that off the main thread, so the page does no work per
 *    frame. Each tick of the player's clock checks it against the real
 *    position and restarts it if they drift apart (seek, stalled audio clock).
 *    The pair is created the first time its clip plays and removed with the
 *    bar; a card that never played has exactly the elements it always had.
 * If element.animate is missing, or an animation turns out not to run the way
 * it was asked to, the still form is updated on every tick, as before.
 */
export default memo(function ProgressBar({ timeSource, duration, onSeek }) {
  const barRef = useRef(null);
  const fillRef = useRef(null);
  const thumbRef = useRef(null);
  const pct = pctOf(timeSource.get(), duration);

  useEffect(() => {
    let parts = null; // { root, fill, track }: the moving form's elements, once built
    let moving = null; // { animations, fromTime, at, rate } while the moving form is shown
    let animateBroken = false;
    let pointerInside = false;
    let lastTime = timeSource.get();
    let lastChangeAt = performance.now();
    let held = false; // playing, but the audio clock is not moving

    const cancel = (animations) => animations.forEach((a) => { try { a.cancel(); } catch { /* already gone */ } });

    // The moving form: the fill is a bar-wide strip slid in from the left
    // inside a clipping box; the thumb sits at the left end of a bar-wide
    // track that slides. Both moved by translateX in % of the bar's width.
    const buildParts = (bar) => {
      const el = (className, parent) => {
        const node = document.createElement("div");
        node.className = className;
        parent.appendChild(node);
        return node;
      };
      const root = document.createElement("div");
      root.className = "pointer-events-none absolute inset-0";
      root.style.display = "none";
      const fill = el("absolute inset-0 bg-primary", el("absolute inset-0 overflow-hidden rounded-sm", root));
      const track = el("absolute inset-0", root);
      const thumb = el(`pointer-events-auto left-0 ${THUMB_CLASS}`, track);
      thumb.style.border = THUMB_STYLE.border;
      thumb.style.boxShadow = THUMB_STYLE.boxShadow;
      bar.appendChild(root);
      return { root, fill, track };
    };

    const showStill = (time) => {
      if (moving) {
        cancel(moving.animations);
        moving = null;
        // Hidden, not removed: a touch that began on the moving thumb keeps
        // its target in the document.
        parts.root.style.display = "none";
        if (fillRef.current) fillRef.current.style.display = "";
        if (thumbRef.current) thumbRef.current.style.display = "";
      }
      const p = `${pctOf(time, duration)}%`;
      if (fillRef.current && fillRef.current.style.width !== p) fillRef.current.style.width = p;
      if (thumbRef.current && thumbRef.current.style.left !== p) thumbRef.current.style.left = p;
    };

    const startMoving = (time, rate, now) => {
      const bar = barRef.current;
      const remainingMs = ((duration - time) / rate) * 1000;
      if (!bar || !(remainingMs > 0) || typeof bar.animate !== "function") return false;
      const p = pctOf(time, duration);
      const timing = { duration: remainingMs, easing: "linear", fill: "both" };
      let animations = [];
      try {
        if (!parts) parts = buildParts(bar);
        animations.push(parts.fill.animate([{ transform: `translateX(${p - 100}%)` }, { transform: "translateX(0%)" }], timing));
        animations.push(parts.track.animate([{ transform: `translateX(${p}%)` }, { transform: "translateX(100%)" }], timing));
        // Start counting from this instant. Left alone, an animation starts
        // when the browser gets round to it — a frame or several later when
        // the page is busy starting the clip — and stays that far behind.
        animations.forEach((a) => { a.startTime = now; });
      } catch {
        cancel(animations);
        animateBroken = true;
        return false; // the caller shows the still form
      }
      if (moving) cancel(moving.animations);
      else {
        parts.root.style.display = "";
        if (fillRef.current) fillRef.current.style.display = "none";
        if (thumbRef.current) thumbRef.current.style.display = "none";
      }
      moving = { animations, fromTime: time, at: now, rate };
      return true;
    };

    // Is the animation doing what it was asked to — running, and as far in as
    // the time since it started? (A browser that ignores the start time, uses
    // another clock, or pauses it would leave the bar off for the whole clip.)
    const animationIsTrue = (now) => {
      const elapsed = now - moving.at;
      if (elapsed < ANIMATION_SETTLE_MS) return true;
      const a = moving.animations[1];
      const at = Math.min(elapsed, Number(a.effect ? a.effect.getTiming().duration : elapsed));
      return (a.playState === "running" || a.playState === "finished")
        && Math.abs(Number(a.currentTime) - at) < ANIMATION_SLACK_MS;
    };

    const sync = () => {
      const time = timeSource.get();
      const rate = timeSource.getRate();
      const changed = time !== lastTime;
      lastTime = time;
      if (!(rate > 0) || !duration || animateBroken || pointerInside) { held = false; showStill(time); return; }
      if (held && !changed) return;
      held = false;
      const now = performance.now();
      if (changed || !moving) lastChangeAt = now;
      if (moving && moving.rate === rate) {
        if (!animationIsTrue(now)) { animateBroken = true; showStill(time); return; }
        const expected = moving.fromTime + ((now - moving.at) / 1000) * rate;
        if (Math.abs(expected - time) <= RESYNC_TOLERANCE) return;
        if (!changed) {
          // The animation is ahead of a position that is standing still. A
          // clock that moves in steps catches up by itself; one that has not
          // moved for STALL_MS is stalled: hold the bar where the audio is.
          // It starts moving again when the position does.
          if (now - lastChangeAt < STALL_MS) return;
          held = true;
          showStill(time);
          return;
        }
      }
      if (!startMoving(time, rate, now)) showStill(time);
    };

    const bar = barRef.current;
    const onEnter = () => { pointerInside = true; sync(); };
    const onLeave = () => { pointerInside = false; sync(); };
    bar.addEventListener("pointerenter", onEnter);
    bar.addEventListener("pointerleave", onLeave);
    sync();
    const unsubscribe = timeSource.subscribe(sync);
    return () => {
      unsubscribe();
      bar.removeEventListener("pointerenter", onEnter);
      bar.removeEventListener("pointerleave", onLeave);
      showStill(timeSource.get());
      if (parts) { parts.root.remove(); parts = null; }
    };
  }, [timeSource, duration]);

  const seekFromEvent = useCallback((clientX) => {
    if (!barRef.current || !duration) return;
    const rect = barRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  }, [duration, onSeek]);

  const handlePointerDown = useCallback((e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromEvent(e.clientX);
  }, [seekFromEvent]);

  const handlePointerMove = useCallback((e) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      seekFromEvent(e.clientX);
    }
  }, [seekFromEvent]);

  return (
    <div className="py-1.5">
      <div
        ref={barRef}
        className="relative h-1 w-full cursor-pointer rounded-sm"
        style={{ background: "var(--border)" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
      >
        {/* Fill */}
        <div
          ref={fillRef}
          className="pointer-events-none absolute inset-y-0 left-0 rounded-sm bg-primary"
          style={{ width: `${pct}%` }}
        />
        {/* Thumb */}
        <div
          ref={thumbRef}
          className={THUMB_CLASS}
          style={{ left: `${pct}%`, ...THUMB_STYLE }}
        />
        {/* The effect above appends the moving form here the first time the clip plays. */}
      </div>
    </div>
  );
})
