"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const DRAG_THRESHOLD = 10; // px before a press counts as a drag rather than a click — was 5,
// tighter than Android's own 8px touch slop, so ordinary finger jitter on a tap
// read as a drag and the click that followed was swallowed by design.

/**
 * Free-position drag for a fixed-position element, persisted in localStorage.
 *
 * Returns a ref to attach to the element, pointer handlers to spread onto it,
 * and the resolved position. Anything inside the element marked with
 * `data-drag-handle` starts a drag; everything else stays clickable.
 *
 * Callers sharing a storageKey share a position — the capture button and the
 * panel it opens are the same object to the user, so a drag of one has to move
 * the other, or clicking would appear to teleport it.
 *
 * @param {string}  storageKey  localStorage key; callers sharing it share a position
 * @param {boolean} enabled     false pins the element to its CSS default (phones)
 */
export default function useDraggablePosition(storageKey, enabled = true) {
  const [pos, setPos] = useState(null);
  const elRef = useRef(null);
  const dragRef = useRef(null);
  const justDraggedRef = useRef(false); // swallow the click that ends a drag

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p.x === "number" && typeof p.y === "number") setPos(p);
      }
    } catch {
      // ignore malformed storage
    }
  }, [storageKey]);

  const clamp = useCallback((x, y) => {
    const el = elRef.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    return {
      x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w)),
      y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h)),
    };
  }, []);

  const onPointerDown = useCallback((e) => {
    if (!enabled) return;
    if (!e.target.closest?.("[data-drag-handle]")) return;
    const rect = elRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      originX: rect.left, originY: rect.top,
      pointerId: e.pointerId, moved: false,
    };
  }, [enabled]);

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!d.moved) {
      // Capture only once a real drag starts. Capturing on pointerdown
      // retargets the following click away from any inner buttons.
      d.moved = true;
      elRef.current?.setPointerCapture?.(d.pointerId);
    }
    // Pointer events can outpace the display, and each setPos is a render.
    // Coalescing onto the next frame means one render per painted frame
    // instead of several that are never seen.
    d.pendingX = d.originX + dx;
    d.pendingY = d.originY + dy;
    if (d.raf) return;
    d.raf = requestAnimationFrame(() => {
      const cur = dragRef.current;
      if (!cur) return;
      cur.raf = 0;
      setPos(clamp(cur.pendingX, cur.pendingY));
    });
  }, [clamp]);

  const onPointerUp = useCallback((e) => {
    const d = dragRef.current;
    dragRef.current = null;
    // Drop a frame that has not run yet; it would read the cleared ref.
    if (d?.raf) cancelAnimationFrame(d.raf);
    if (!d?.moved) return;
    elRef.current?.releasePointerCapture?.(e.pointerId);
    justDraggedRef.current = true;
    setPos((prev) => {
      // The last move may still be sitting in that cancelled frame, so settle
      // on it here rather than saving a position one frame behind the cursor.
      const p = d.pendingX != null ? clamp(d.pendingX, d.pendingY) : prev;
      if (!p) return prev;
      // Store the distance to the *right and bottom* edges as well. Elements
      // sharing a key can be different sizes — the capture button is a pill,
      // the panel it opens is a tall card — and pinning only the top-left
      // corner would make the taller one clamp back on screen, so opening it
      // looked like a jump. Whichever edge it was dragged nearest wins.
      const el = elRef.current;
      const saved = {
        ...p,
        right: Math.max(0, window.innerWidth - p.x - (el?.offsetWidth ?? 0)),
        bottom: Math.max(0, window.innerHeight - p.y - (el?.offsetHeight ?? 0)),
      };
      try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch {}
      return saved;
    });
  }, [storageKey, clamp]);

  const onClickCapture = useCallback((e) => {
    if (!justDraggedRef.current) return;
    justDraggedRef.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  // Re-clamp on resize so a saved position never strands the element
  // off-screen. Width lives in state rather than being read during render,
  // which would not match what the server rendered.
  const [isWide, setIsWide] = useState(false);
  useEffect(() => {
    const sync = () => {
      setIsWide(window.innerWidth >= 640);
      setPos((p) => (p ? clamp(p.x, p.y) : p));
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [clamp]);

  const active = enabled && isWide && pos;

  // Anchor to whichever edge the element was dragged closest to, so elements of
  // different sizes sharing this position stay visually in the same corner.
  let style;
  if (active) {
    const nearRight = pos.right != null && pos.right < pos.x;
    const nearBottom = pos.bottom != null && pos.bottom < pos.y;
    style = {
      ...(nearRight ? { right: pos.right, left: "auto" } : { left: pos.x, right: "auto" }),
      ...(nearBottom ? { bottom: pos.bottom, top: "auto" } : { top: pos.y, bottom: "auto" }),
    };
  }

  return {
    ref: elRef,
    // Spread onto the element; positions it only once actually dragged.
    dragProps: { onPointerDown, onPointerMove, onPointerUp, onClickCapture },
    style,
    isDragged: Boolean(active),
  };
}
