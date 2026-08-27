"use client";

/**
 * The key and tempo a song opens in when it has none of its own.
 *
 * Floating and always open. It belongs to the singer rather than to any one
 * card, and it has to be usable while a card is playing — choosing a default
 * without hearing it is a guess. Hiding it behind a tap would put a click
 * between the ear and the adjustment, which is the wrong way round for
 * something tuned by listening.
 *
 * Two rows, laid out the same way: minus, the current value, plus. The value
 * in the middle is what is actually in force, so the row reads as one thing
 * rather than as a control and a separate readout.
 */

import { PITCH_STEPS, SPEED_STEPS, sameValue, stepAlong } from "./ladderStyle";

/**
 * Signed, so +2 and −2 are told apart without reading the sign twice.
 *
 * 0 rather than 原调, matching the ladders on the cards: the two are read
 * together and a word among numbers made the column jump.
 */
function pitchLabel(n) {
  const v = typeof n === "number" ? n : 0;
  return v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.abs(v)}`;
}

/**
 * Written as the ladder writes it — 1, not 1.00 — since the two are read
 * together. The column has a fixed width, so nothing jumps.
 */
function speedLabel(n) {
  return String(typeof n === "number" ? n : 1);
}

const STEP_BUTTON = "flex h-6 w-6 shrink-0 items-center justify-center rounded-md "
  + "border border-border text-xs leading-none text-muted transition-colors "
  + "hover:border-accent hover:text-theme disabled:opacity-30";

function Stepper({ label, value, onStep, canDown, canUp, disabled }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-7 shrink-0 text-[0.65rem] text-muted">{label}</span>
      <button
        type="button"
        disabled={disabled || !canDown}
        onClick={() => onStep(-1)}
        className={STEP_BUTTON}
      >
        −
      </button>
      {/* Fixed width so the buttons hold still as the number changes, and the
          same face the ladders use so the two read as one family. */}
      <span className="w-12 text-center font-mono text-[0.7rem] text-theme">
        {value}
      </span>
      <button
        type="button"
        disabled={disabled || !canUp}
        onClick={() => onStep(1)}
        className={STEP_BUTTON}
      >
        +
      </button>
    </div>
  );
}

export default function DefaultTuning({ defaults, onChange, disabled }) {
  const pitch = typeof defaults?.pitch === "number" ? defaults.pitch : 0;
  const speed = typeof defaults?.speed === "number" ? defaults.speed : 1;

  // Walks the card's own ladders rather than counting in fixed increments, so
  // a default can only ever be a value the card can show as selected. Stepping
  // by one semitone would let the default reach -3, where the row underneath
  // would light no button at all while the song played shifted.
  const stepPitch = (dir) => {
    const next = stepAlong(PITCH_STEPS, pitch, dir);
    if (next !== pitch) onChange({ pitch: next });
  };

  const stepSpeed = (dir) => {
    const next = stepAlong(SPEED_STEPS, speed, dir);
    if (!sameValue(next, speed)) onChange({ speed: next });
  };

  return (
    <div
      // Above the cards, below any dialog. Clear of the bottom edge on a phone
      // so it does not sit under the thumb rest.
      className="fixed bottom-4 right-4 z-30 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-xl sm:bottom-6 sm:right-6"
    >
      <div className="mb-2 text-[0.7rem] font-medium text-theme">全局设置</div>

      <div className="space-y-1.5">
        <Stepper
          label="变调"
          value={pitchLabel(defaults?.pitch)}
          onStep={stepPitch}
          canDown={pitch > PITCH_STEPS[0]}
          canUp={pitch < PITCH_STEPS[PITCH_STEPS.length - 1]}
          disabled={disabled}
        />
        <Stepper
          label="变速"
          value={speedLabel(defaults?.speed)}
          onStep={stepSpeed}
          canDown={speed > SPEED_STEPS[0]}
          canUp={speed < SPEED_STEPS[SPEED_STEPS.length - 1]}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
