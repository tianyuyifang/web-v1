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

const PITCH_MIN = -6;
const PITCH_MAX = 6;
/** Matches the player's own clamp, and the service's. */
const SPEED_MIN = 0.5;
const SPEED_MAX = 2;
const SPEED_STEP = 0.05;

/** Signed, so +2 and −2 are told apart without reading the sign twice. */
function pitchLabel(n) {
  const v = typeof n === "number" ? n : 0;
  return v === 0 ? "原调" : `${v > 0 ? "+" : "−"}${Math.abs(v)}`;
}

/**
 * Two decimals, because the step is 0.05 and 1.1 would otherwise sit beside
 * 1.15 with a different width and make the column jump.
 */
function speedLabel(n) {
  return `${(typeof n === "number" ? n : 1).toFixed(2)}x`;
}

/** Floating-point addition leaves 1.0500000000000003; the step is exact. */
function roundStep(n) {
  return Math.round(n * 100) / 100;
}

function Stepper({ label, value, onStep, canDown, canUp, disabled }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-7 shrink-0 text-[0.65rem] text-muted">{label}</span>
      <button
        type="button"
        disabled={disabled || !canDown}
        onClick={() => onStep(-1)}
        className="h-6 w-6 shrink-0 rounded border border-border text-xs leading-none text-muted hover:border-accent hover:text-theme disabled:opacity-30"
      >
        −
      </button>
      {/* Fixed width so the buttons hold still as the number changes. */}
      <span className="w-14 text-center font-mono text-[0.72rem] text-theme">
        {value}
      </span>
      <button
        type="button"
        disabled={disabled || !canUp}
        onClick={() => onStep(1)}
        className="h-6 w-6 shrink-0 rounded border border-border text-xs leading-none text-muted hover:border-accent hover:text-theme disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

export default function DefaultTuning({ defaults, onChange, disabled }) {
  const pitch = typeof defaults?.pitch === "number" ? defaults.pitch : 0;
  const speed = typeof defaults?.speed === "number" ? defaults.speed : 1;

  const stepPitch = (dir) => {
    const next = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch + dir));
    if (next !== pitch) onChange({ pitch: next });
  };

  const stepSpeed = (dir) => {
    const next = roundStep(Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed + dir * SPEED_STEP)));
    if (next !== speed) onChange({ speed: next });
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
          canDown={pitch > PITCH_MIN}
          canUp={pitch < PITCH_MAX}
          disabled={disabled}
        />
        <Stepper
          label="变速"
          value={speedLabel(defaults?.speed)}
          onStep={stepSpeed}
          canDown={speed > SPEED_MIN}
          canUp={speed < SPEED_MAX}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
