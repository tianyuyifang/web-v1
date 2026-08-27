"use client";

import { LADDER_BUTTON, LADDER_TINT, LadderExtra } from "./ladderStyle";

/**
 * Tempo for the 唱卡 card: every useful speed in one row, one press each.
 *
 * It was a stepper over the same ladder, which meant walking to 1.3 four
 * presses at a time. Someone who wants to skim a song knows that before they
 * reach for the control.
 *
 * Deliberately uneven: 0.05 steps through the range someone actually sings at,
 * then a jump to 1.3 for skimming. A fixed step would invent values nobody
 * asked for and make the useful end take twice as many presses.
 *
 * A copy of SpeedControl rather than a variant of it. The shared one is a
 * select rendered by PlayerBox and the playlist batch editor, where a change
 * writes a row; this one drives the audio of a card. Keeping them apart means
 * a change made for singing cannot reach a page that stores what it is given.
 */

/** The speeds worth one press, slow to fast. 1 is the way home. */
const SPEEDS = [0.9, 0.95, 1, 1.05, 1.1, 1.2, 1.3];
const NORMAL = 1;

/** Float-safe, since these arrive from stored values as well as from clicks. */
function same(a, b) {
  return Math.abs(a - b) < 1e-9;
}

export default function LiveSpeedControl({ speed, onChange }) {
  const value = typeof speed === "number" ? speed : NORMAL;

  return (
    <div className="flex items-center gap-1">
      {SPEEDS.map((n) => {
        const active = same(value, n);
        return (
          <button
            key={n}
            type="button"
            onClick={() => { if (!active) onChange(n); }}
            aria-pressed={active}
            title={n === NORMAL ? "原速" : `${n} 倍速`}
            className={`${LADDER_BUTTON} ${
              active
                ? `border-accent font-medium text-accent ${LADDER_TINT}`
                : "border-border text-muted hover:border-accent/50 hover:text-theme"
            }`}
          >
            {n}
          </button>
        );
      })}
      {/* Three decimals, not two: 1.001 rounded to 1.00 reads as normal speed
          while the card plays fast. */}
      {SPEEDS.some((n) => same(value, n)) ? null : (
        <LadderExtra>{Number(value.toFixed(3))}</LadderExtra>
      )}
    </div>
  );
}
