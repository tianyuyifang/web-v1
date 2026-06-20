"use client";

import { useMemo, useCallback, useRef, useState, useEffect } from "react";
import usePlayerStore from "@/store/playerStore";
import { useLanguage } from "@/components/layout/LanguageProvider";
import { findAdjacentUnliked } from "@/lib/clipNav";

const POS_KEY = "floating-clipnav-pos";
const DRAG_THRESHOLD = 5; // px of movement before a press counts as a drag (not a click)

/**
 * Floating control to jump to the previous/next *unliked* clip, relative to the
 * currently-active (last-played) clip in this playlist.
 *
 * Draggable (mouse + touch); position persists in localStorage across sessions.
 * Defaults to bottom-center. Hidden until a clip in this playlist has played.
 */
export default function FloatingClipNav({ clips, playlistId }) {
  const { t } = useLanguage();
  const activePlayerId = usePlayerStore((s) => s.activePlayerId);
  const triggerPlayFromStart = usePlayerStore((s) => s.triggerPlayFromStart);
  const likedClips = usePlayerStore((s) => s.likedClips);

  // Persisted position: {x, y} top-left in px, or null = default bottom-center.
  const [pos, setPos] = useState(null);
  const elRef = useRef(null);
  const dragRef = useRef(null); // { startX, startY, originX, originY, pointerId, moved }
  const justDraggedRef = useRef(false); // swallow the click right after a drag

  // Load saved position once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p.x === "number" && typeof p.y === "number") setPos(p);
      }
    } catch {
      // ignore malformed storage
    }
  }, []);

  const activeIndex = useMemo(() => {
    if (!activePlayerId || !Array.isArray(clips)) return -1;
    const prefix = `${playlistId}-`;
    if (!activePlayerId.startsWith(prefix)) return -1;
    const clipId = activePlayerId.slice(prefix.length);
    return clips.findIndex((c) => c && c.clipId === clipId);
  }, [activePlayerId, clips, playlistId]);

  const prevIdx = useMemo(
    () => findAdjacentUnliked(clips, activeIndex, -1, likedClips, playlistId),
    [clips, activeIndex, likedClips, playlistId]
  );
  const nextIdx = useMemo(
    () => findAdjacentUnliked(clips, activeIndex, 1, likedClips, playlistId),
    [clips, activeIndex, likedClips, playlistId]
  );

  const goPrev = useCallback(() => {
    if (prevIdx >= 0) triggerPlayFromStart(clips[prevIdx].clipId);
  }, [prevIdx, clips, triggerPlayFromStart]);
  const goNext = useCallback(() => {
    if (nextIdx >= 0) triggerPlayFromStart(clips[nextIdx].clipId);
  }, [nextIdx, clips, triggerPlayFromStart]);

  // Clamp a position so the pill stays fully on-screen.
  const clamp = useCallback((x, y) => {
    const el = elRef.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }, []);

  const onPointerDown = useCallback((e) => {
    const el = elRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: rect.left,
      originY: rect.top,
      pointerId: e.pointerId,
      moved: false,
    };
    // NOTE: do NOT capture the pointer here — capturing on the container
    // retargets the following click away from the inner buttons, breaking
    // plain clicks. Capture only once an actual drag begins (below).
  }, []);

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return; // ignore tiny jitters
    if (!d.moved) {
      // Drag threshold crossed — now take pointer capture so the drag tracks
      // even if the cursor leaves the pill.
      d.moved = true;
      elRef.current?.setPointerCapture?.(d.pointerId);
    }
    setPos(clamp(d.originX + dx, d.originY + dy));
  }, [clamp]);

  const onPointerUp = useCallback((e) => {
    const d = dragRef.current;
    if (d?.moved) elRef.current?.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
    if (d?.moved) {
      // Mark that a drag just ended so the synthetic click is swallowed once,
      // then persist the final position.
      justDraggedRef.current = true;
      setPos((p) => {
        if (p) {
          try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch {}
        }
        return p;
      });
    }
  }, []);

  // Block the single click that follows a drag so it doesn't trigger prev/next.
  const onClickCapture = useCallback((e) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, []);

  // Re-clamp on window resize so a saved position never ends up off-screen.
  useEffect(() => {
    if (!pos) return;
    const onResize = () => setPos((p) => (p ? clamp(p.x, p.y) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pos, clamp]);

  if (activeIndex < 0) return null;

  // Default (no saved pos): bottom-center via CSS. Custom pos: absolute coords.
  const style = pos
    ? { left: pos.x, top: pos.y }
    : { left: "50%", bottom: 24, transform: "translateX(-50%)" };

  return (
    <div
      ref={elRef}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClickCapture={onClickCapture}
      className="fixed z-40 flex touch-none cursor-grab select-none items-center gap-1 rounded-full border border-border bg-surface/95 px-1.5 py-1.5 shadow-lg backdrop-blur active:cursor-grabbing"
    >
      <button
        onClick={goPrev}
        disabled={prevIdx < 0}
        aria-label={t("prevUnliked")}
        title={t("prevUnliked")}
        className="flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
          <rect x="5" y="5" width="2.5" height="14" rx="1" />
          <polygon points="20,5 20,19 9,12" />
        </svg>
      </button>
      <button
        onClick={goNext}
        disabled={nextIdx < 0}
        aria-label={t("nextUnliked")}
        title={t("nextUnliked")}
        className="flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
          <polygon points="4,5 4,19 15,12" />
          <rect x="16.5" y="5" width="2.5" height="14" rx="1" />
        </svg>
      </button>
    </div>
  );
}
