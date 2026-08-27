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
