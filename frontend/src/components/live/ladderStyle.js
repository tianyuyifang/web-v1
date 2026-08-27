"use client";

/**
 * The look the two 唱卡 ladders share.
 *
 * Shared because the whole point is that they line up: the pitch row and the
 * tempo row sit one above the other, and a button that is a few pixels wider
 * on one of them makes both look like a mistake. Sizing each to its own text
 * did exactly that — `1.05` is wider than `0`.
 *
 * So the width is fixed rather than minimum, and it is fixed HERE rather than
 * in each file, where the two would drift the first time one of them changed.
 */

/**
 * The keys and tempos a singer can reach, low to high.
 *
 * Here rather than in the controls, because three places use them now: the two
 * ladders on the card, and the global default's stepper, which walks this list
 * rather than counting in fixed increments. If the default could reach a value
 * the card cannot show — 1.15, say — the row underneath would light no button
 * at all while the song played shifted.
 *
 * Pitch moves in twos: the odd semitones are reachable and playable, they just
 * are not what people choose in. Tempo is deliberately uneven — 0.05 through
 * the range someone sings at, then a jump to 1.3 for skimming.
 */
export const PITCH_STEPS = [-6, -4, -2, 0, 2, 4, 6];
export const SPEED_STEPS = [0.9, 0.95, 1, 1.05, 1.1, 1.2, 1.3];

/** Float-safe: these arrive from stored values as well as from clicks. */
export function sameValue(a, b) {
  return Math.abs(a - b) < 1e-9;
}

/**
 * The neighbour of `value` in `steps`, one press away in `dir`.
 *
 * A value off the ladder — an older stored preference, or one saved before the
 * ladders existed — steps to the nearest rung in that direction rather than
 * refusing to move, so the control is never stuck.
 */
export function stepAlong(steps, value, dir) {
  const exact = steps.findIndex((n) => sameValue(n, value));
  if (exact >= 0) {
    const next = exact + (dir > 0 ? 1 : -1);
    return steps[Math.max(0, Math.min(steps.length - 1, next))];
  }
  const found = dir > 0
    ? steps.find((n) => n > value)
    : [...steps].reverse().find((n) => n < value);
  return found === undefined ? (dir > 0 ? steps[steps.length - 1] : steps[0]) : found;
}

/**
 * Wide enough for the longest label on either ladder (`1.05`, four glyphs) at
 * this size, which makes every button on both rows identical.
 *
 * `bg-background` rather than nothing: the open card is a surface darkened by
 * a black wash, so a transparent button was the same colour as the card it sat
 * on and read as text with a hairline round it. The background token is the
 * darker of the two, so the row sits INTO the card rather than on top of it —
 * and it is a token rather than a fixed colour, so it inverts with the theme
 * instead of turning into a dark smear on the light one.
 */
/**
 * The fill behind a selected button.
 *
 * An inline style rather than `bg-accent/25`, which renders nothing at all:
 * --accent is a plain hex, so Tailwind cannot derive an alpha channel from it
 * and the slash utilities silently produce no rule. (The same is true of the
 * `bg-accent/10` used elsewhere in the app -- it has never painted anything.)
 * color-mix keeps the value tied to the token, so it still follows the theme.
 */
export const LADDER_TINT = "[background-color:color-mix(in_srgb,var(--accent)_22%,transparent)]";

export const LADDER_BUTTON = "h-[1.35rem] w-[2.35rem] shrink-0 rounded "
  + "border bg-background text-center font-mono text-[0.62rem] leading-none "
  + "transition-colors";

/**
 * The value in force when it has no button of its own.
 *
 * A stored per-song preference moves by one semitone and the global default
 * moves tempo by 0.05, so -3 and 1.15 both happen. Left out, the row would
 * show nothing selected — which reads as unshifted while the card is really
 * playing shifted, the one wrong answer.
 *
 * Deliberately not button-shaped: it cannot be pressed, and looking pressable
 * would invite the click that does nothing.
 */
export function LadderExtra({ children }) {
  return (
    <span className={`ml-1 flex h-[1.35rem] items-center rounded border border-accent/60 px-1.5 font-mono text-[0.62rem] leading-none text-accent ${LADDER_TINT}`}>
      {children}
    </span>
  );
}
