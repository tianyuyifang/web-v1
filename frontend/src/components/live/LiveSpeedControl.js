"use client";

/**
 * Tempo for the 唱卡 card: three buttons, one press each.
 *
 * A copy of SpeedControl rather than a variant of it. The shared one is a
 * select rendered by PlayerBox and the playlist batch editor, where a change
 * writes a row; this one drives the audio of a card that forgets everything
 * when it closes. Keeping them apart means a change made for singing cannot
 * reach a page that stores what it is given.
 *
 * The select was two actions — open it, then aim at a row — which is two too
 * many for someone mid-song with their eyes on the words.
 */

/**
 * The speeds worth having, in order.
 *
 * Deliberately uneven: 0.05 steps through the range someone actually sings at,
 * then a jump to 1.3 for skimming. A fixed step would invent values nobody
 * asked for (1.25) and make the useful end take twice as many presses.
 */
const SPEEDS = [0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2, 1.3];
const NORMAL = 1.0;

/** Nearest listed speed, so an odd incoming value still lands somewhere real. */
function nearest(speed) {
  let best = 0;
  for (let i = 1; i < SPEEDS.length; i++) {
    if (Math.abs(SPEEDS[i] - speed) < Math.abs(SPEEDS[best] - speed)) best = i;
  }
  return best;
}

/** Whether a value is one of the listed speeds. */
function onLadder(speed) {
  return SPEEDS.some((s) => Math.abs(s - speed) < 1e-9);
}

export default function LiveSpeedControl({ speed, onChange }) {
  const i = nearest(speed);
  // Judged on the value itself, not the rung it snaps to: 1.01 is not normal
  // speed, and saying it is would hide a card playing slightly fast.
  const atNormal = Math.abs(speed - NORMAL) < 1e-9;

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(SPEEDS[Math.max(0, i - 1)])}
        disabled={i <= 0}
        title="慢一点"
        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-theme hover:bg-surface-hover disabled:opacity-30"
      >
        -
      </button>
      <button
        type="button"
        onClick={() => { if (!atNormal) onChange(NORMAL); }}
        aria-disabled={atNormal}
        title={atNormal ? "原速" : "回到原速"}
        className={`min-w-[2.5rem] rounded border px-1 py-0.5 text-center text-xs ${
          atNormal
            ? "cursor-default border-transparent text-muted"
            : "border-border text-accent hover:bg-surface-hover"
        }`}
      >
        {/* Three decimals, not two: 1.001 rounded to 1.00 reads as "1x", which
            looks exactly like normal speed while the card plays fast. */}
        {atNormal ? "原速" : `${onLadder(speed) ? SPEEDS[i] : Number(speed.toFixed(3))}x`}
      </button>
      <button
        type="button"
        onClick={() => onChange(SPEEDS[Math.min(SPEEDS.length - 1, i + 1)])}
        disabled={i >= SPEEDS.length - 1}
        title="快一点"
        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-theme hover:bg-surface-hover disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}
