"use client";

/**
 * Pitch control for the 唱卡 card, with a one-press way back to the original
 * key.
 *
 * A copy of PitchControl rather than a prop on it. The shared one is rendered
 * by PlayerBox and by the playlist batch editor, where every change is written
 * straight to the database — so the same widget has to mean different things in
 * the two places, and a copy keeps that difference from ever leaking into
 * pages this feature has nothing to do with.
 *
 * Nothing here is saved. The live card shifts the audio it is playing and
 * forgets when the card closes, which is why the reset can be free of the
 * "would this write a row" question entirely.
 */

const MIN = -6;
const MAX = 6;

export default function LivePitchControl({ pitch, onChange }) {
  const atOriginal = pitch === 0;

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(MIN, pitch - 1))}
        disabled={pitch <= MIN}
        title="降一个半音"
        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-theme hover:bg-surface-hover disabled:opacity-30"
      >
        -
      </button>
      {/* The reading doubles as the way home. Getting back to the original key
          meant counting presses back to zero, which is the one thing a singer
          needs to do quickly mid-song: the shifted key is the experiment, the
          original is where they started. */}
      <button
        type="button"
        onClick={() => { if (!atOriginal) onChange(0); }}
        aria-disabled={atOriginal}
        title={atOriginal ? "原调" : "回到原调"}
        className={`min-w-[2.5rem] rounded border px-1 py-0.5 text-center text-xs ${
          atOriginal
            ? "cursor-default border-transparent text-muted"
            : "border-border text-accent hover:bg-surface-hover"
        }`}
      >
        {atOriginal ? "原调" : pitch > 0 ? `+${pitch}` : pitch}
      </button>
      <button
        type="button"
        onClick={() => onChange(Math.min(MAX, pitch + 1))}
        disabled={pitch >= MAX}
        title="升一个半音"
        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-theme hover:bg-surface-hover disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}
