"use client";

import { useEffect, useState } from "react";

/**
 * Output level for 唱卡, remembered per device.
 *
 * The page had no volume control at all, so the only way down was the system
 * mixer — which also turns down everything else, including whatever the singer
 * is listening to the room on. Platform masters differ by a lot between eras
 * and labels, so "a bit loud" is the ordinary case rather than a fault.
 *
 * localStorage rather than the account, because this is a property of the
 * device and not of the person: the level that suits headphones on a laptop is
 * wrong through a speaker in a room, and the same singer uses both.
 */

const KEY = "live_volume";

/** Read once, defensively — a corrupt or hand-edited value must not break the page. */
export function loadStoredVolume() {
  if (typeof window === "undefined") return 1;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return 1;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
  } catch {
    // Private browsing and blocked storage both throw here rather than
    // returning null. Full volume is the right answer either way.
    return 1;
  }
}

function store(v) {
  try { window.localStorage.setItem(KEY, String(v)); } catch { /* see above */ }
}

function SpeakerIcon({ level }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M4 9.5v5a1 1 0 0 0 1 1h3l4 3.5a.75.75 0 0 0 1.25-.56V4.56A.75.75 0 0 0 12 4l-4 3.5H5a1 1 0 0 0-1 1z" />
      {/* The waves say how loud without needing the number read. */}
      {level > 0.02 ? <path d="M16 9.2a4 4 0 0 1 0 5.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : null}
      {level > 0.5 ? <path d="M18.4 6.8a7.5 7.5 0 0 1 0 10.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : null}
      {level <= 0.02 ? <path d="M16.5 9.5l4 5M20.5 9.5l-4 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : null}
    </svg>
  );
}

export default function LiveVolumeControl({ volume, onChange }) {
  // Rendered from a prop so the player stays the single source of truth, but
  // the stored value has to reach it once on mount.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) return;
    setReady(true);
    const stored = loadStoredVolume();
    if (stored !== volume) onChange(stored);
    // Deliberately once: this restores a preference, it does not follow one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const set = (v) => {
    onChange(v);
    store(v);
  };

  const pct = Math.round(volume * 100);

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => set(volume > 0 ? 0 : 1)}
        title={volume > 0 ? "静音" : "取消静音"}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:text-theme"
      >
        <SpeakerIcon level={volume} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={(e) => set(Number(e.target.value))}
        // The card listens for space and w/s to drive the audio; a focused
        // slider would take those keys and move itself instead.
        onKeyDown={(e) => e.stopPropagation()}
        aria-label="音量"
        className="h-1 w-20 cursor-pointer accent-accent"
      />
      <span className="w-8 shrink-0 text-right font-mono text-[0.62rem] text-muted">
        {pct}%
      </span>
    </div>
  );
}
