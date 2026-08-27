"use client";

import { LADDER_BUTTON, LADDER_TINT, LadderExtra } from "./ladderStyle";

/**
 * Pitch for the 唱卡 card: every useful key in one row, one press each.
 *
 * It was a stepper, which meant six presses to reach the bottom of the range
 * and six back. A singer who knows they sing two below has no reason to walk
 * there a semitone at a time, and mid-song there is no time to.
 *
 * Even steps of two, because that is the resolution people actually choose in:
 * the odd semitones exist on the ladder the card can hold, but nobody asks for
 * +3 without having tried +2 and +4 first. An odd value arriving from a stored
 * preference still shows correctly — it just has no button of its own.
 *
 * A copy of PitchControl rather than a prop on it. The shared one is rendered
 * by PlayerBox and by the playlist batch editor, where every change is written
 * straight to the database — so the same widget has to mean different things in
 * the two places, and a copy keeps that difference from ever leaking into
 * pages this feature has nothing to do with.
 */

/** The keys worth one press, low to high. 0 is the way home. */
const STEPS = [-6, -4, -2, 0, 2, 4, 6];

export default function LivePitchControl({ pitch, onChange }) {
  const value = typeof pitch === "number" ? pitch : 0;

  return (
    <div className="flex items-center gap-1">
      {STEPS.map((n) => {
        const active = value === n;
        return (
          <button
            key={n}
            type="button"
            onClick={() => { if (!active) onChange(n); }}
            aria-pressed={active}
            title={n === 0 ? "原调" : `${n > 0 ? "升" : "降"} ${Math.abs(n)} 个半音`}
            className={`${LADDER_BUTTON} ${
              active
                ? `border-accent font-medium text-accent ${LADDER_TINT}`
                : "border-border text-muted hover:border-accent/50 hover:text-theme"
            }`}
          >
            {n > 0 ? `+${n}` : n}
          </button>
        );
      })}
      {/* An odd key can still be in force — a stored preference, or the global
          default, both of which move by one. It has no button, so it is shown
          here rather than left invisible while the row reads as unshifted. */}
      {STEPS.includes(value) ? null : (
        <LadderExtra>{value > 0 ? `+${value}` : value}</LadderExtra>
      )}
    </div>
  );
}
