"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The key and tempo a song opens in when it has none of its own.
 *
 * Floating, because it belongs to the singer rather than to any one card, and
 * because it has to be reachable while a card is open — choosing a default by
 * ear means hearing it on the song in front of you.
 *
 * Collapsed to a small tab by default. Expanded it would sit over the cards it
 * exists to serve, and most of the time it has nothing to say: it is set once,
 * early, and then left alone.
 */

const PITCH_MIN = -6;
const PITCH_MAX = 6;
const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25];

/** Signed, so +2 and -2 are told apart at a glance. */
function pitchLabel(n) {
  if (typeof n !== "number") return "原调";
  return n === 0 ? "原调" : `${n > 0 ? "+" : ""}${n}`;
}

function speedLabel(n) {
  return typeof n === "number" ? `${n}x` : "1x";
}

export default function DefaultTuning({ defaults, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const pitch = typeof defaults?.pitch === "number" ? defaults.pitch : 0;
  const speed = typeof defaults?.speed === "number" ? defaults.speed : 1;
  // Whether anything has actually been chosen, as opposed to sitting on the
  // values that happen to be the originals. The tab says so, because "no
  // default" and "a default of the original key" behave differently for songs
  // set individually later.
  const isSet = typeof defaults?.pitch === "number" || typeof defaults?.speed === "number";

  const step = (delta) => {
    const next = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch + delta));
    if (next !== pitch) onChange({ pitch: next });
  };

  return (
    <div
      ref={boxRef}
      // Above the cards but below any dialog. Bottom-right on a desktop; on a
      // phone it sits clear of the thumb rest at the bottom edge.
      className="fixed bottom-4 right-4 z-30 sm:bottom-6 sm:right-6"
    >
      {open ? (
        <div className="w-56 rounded-xl border border-border bg-surface p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[0.72rem] font-medium text-theme">默认调与速度</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-1 text-xs text-muted hover:text-theme"
              title="收起"
            >
              ×
            </button>
          </div>

          {/* Said outright, because the rule is not guessable from the numbers:
              a song adjusted on its own keeps what it was given. */}
          <p className="mb-2.5 text-[0.62rem] leading-snug text-muted">
            用在没有单独设过的歌上。单独设过的歌保持自己的设置。
          </p>

          <div className="mb-2 flex items-center gap-1.5">
            <span className="w-7 shrink-0 text-[0.65rem] text-muted">变调</span>
            <button
              type="button"
              disabled={disabled || pitch <= PITCH_MIN}
              onClick={() => step(-1)}
              className="h-6 w-6 rounded border border-border text-xs text-muted hover:border-accent hover:text-theme disabled:opacity-30"
            >
              −
            </button>
            <span className="w-10 text-center font-mono text-[0.72rem] text-theme">
              {pitchLabel(defaults?.pitch)}
            </span>
            <button
              type="button"
              disabled={disabled || pitch >= PITCH_MAX}
              onClick={() => step(1)}
              className="h-6 w-6 rounded border border-border text-xs text-muted hover:border-accent hover:text-theme disabled:opacity-30"
            >
              +
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="w-7 shrink-0 text-[0.65rem] text-muted">变速</span>
            <div className="flex flex-wrap gap-1">
              {SPEEDS.map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ speed: v })}
                  className={`rounded border px-1.5 py-0.5 font-mono text-[0.65rem] transition-colors disabled:opacity-30 ${
                    speed === v
                      ? "border-accent text-accent"
                      : "border-border text-muted hover:border-accent hover:text-theme"
                  }`}
                >
                  {v}x
                </button>
              ))}
            </div>
          </div>

          {isSet ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange({ pitch: null, speed: null })}
              className="mt-2.5 w-full rounded border border-border py-1 text-[0.65rem] text-muted hover:border-accent hover:text-theme disabled:opacity-30"
            >
              取消默认
            </button>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-2 text-[0.7rem] shadow-lg transition-colors ${
            isSet
              ? "border-accent/60 bg-surface text-accent"
              : "border-border bg-surface text-muted hover:text-theme"
          }`}
          title="设置默认的调与速度"
        >
          <span>默认</span>
          <span className="font-mono">
            {pitchLabel(defaults?.pitch)}
            {typeof defaults?.speed === "number" && defaults.speed !== 1
              ? ` · ${speedLabel(defaults.speed)}`
              : ""}
          </span>
        </button>
      )}
    </div>
  );
}
