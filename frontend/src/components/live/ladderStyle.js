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
 */
export const LADDER_BUTTON = "h-6 w-11 shrink-0 rounded-md border text-center "
  + "font-mono text-[0.68rem] leading-none transition-colors";

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
    <span className="ml-1 flex h-6 items-center rounded-md bg-accent/15 px-1.5 font-mono text-[0.68rem] leading-none text-accent">
      {children}
    </span>
  );
}
