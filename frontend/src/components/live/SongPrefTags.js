"use client";

import { memo, useEffect, useRef, useState } from "react";
import { PRESET_COLORS } from "../player/ColorTag";

/**
 * A singer's own marks on a 唱卡 card: colour flags and a note.
 *
 * Not ColorTag, though it shares that component's palette, its pipe-separated
 * storage and now its silhouette. ColorTag is pinned to the top-right corner
 * of a playlist row by absolute positioning and drops in with an animation;
 * this sits inline in a header line that already carries a title, a stage
 * label and a confirmation badge, where a corner-anchored flag would land on
 * top of them. What is worth sharing is the meaning — the same colour, the
 * same shape, the same thing.
 */

/**
 * The same silhouette the playlist cards use, at the size this row allows.
 *
 * Copied rather than imported: ColorTag's is bound up with its absolute
 * corner positioning and its drop animation, neither of which belongs in a
 * flex row. The path is what carries the meaning, so that is what is shared.
 */
function Bookmark({ color, size = 13 }) {
  return (
    <svg
      width={size}
      height={Math.round((size * 28) / 18)}
      viewBox="0 0 18 28"
      style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.35))" }}
      aria-hidden="true"
    >
      <path d="M0 0h18v23l-9-5-9 5V0z" fill={color} />
    </svg>
  );
}

/** Storage is one string so the row stays flat — the same shape PlaylistClip uses. */
export function parseColors(colorTag) {
  return colorTag ? colorTag.split("|").filter(Boolean) : [];
}

export function serializeColors(colors) {
  return colors.length ? colors.join("|") : null;
}

/**
 * The read-only marks, for the collapsed row.
 *
 * Renders nothing at all when there is nothing to show, so an untouched card
 * keeps exactly the header it has today.
 */
export const SongPrefMarks = memo(function SongPrefMarks({ prefs }) {
  const colors = parseColors(prefs?.colorTag);
  const note = prefs?.note;
  if (!colors.length && !note) return null;

  return (
    <>
      {note ? (
        // Allowed to shrink and truncate: the badge after it says whether the
        // song is confirmed, which must stay legible however long the note is.
        <span
          className="min-w-0 max-w-[14rem] shrink truncate text-[0.7rem] text-muted"
          title={note}
        >
          {note}
        </span>
      ) : null}
      {colors.length ? (
        // Hung from the top of the row, the way a bookmark sits on a page.
        // -mt-1.5 lifts them into the row's padding so they read as attached
        // to it rather than floating in the middle of the text line.
        <span className="-mt-1.5 flex shrink-0 items-start gap-1 self-start">
          {colors.map((c) => (
            <Bookmark key={c} color={c} />
          ))}
        </span>
      ) : null}
    </>
  );
});

/**
 * The editor, shown inside an open card.
 *
 * Colours commit on click and the note on blur. Both are deliberate acts, so
 * neither waits for the card to close the way the key and tempo do — those are
 * arrived at by ear, through values the singer is only trying out.
 */
export default function SongPrefEditor({ prefs, onChange, disabled }) {
  const colors = parseColors(prefs?.colorTag);
  const [note, setNote] = useState(prefs?.note || "");
  const [open, setOpen] = useState(false);
  const paletteRef = useRef(null);

  /**
   * Follow the stored note, but never while it is being edited.
   *
   * The feed refetches on reconnect and re-resolves every card, so this prop
   * changes identity underneath an open box. Without the focus check, a
   * refetch mid-sentence would overwrite what was being typed.
   */
  const boxRef = useRef(null);
  useEffect(() => {
    if (document.activeElement === boxRef.current) return;
    setNote(prefs?.note || "");
  }, [prefs?.note]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (paletteRef.current && !paletteRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const toggleColor = (c) => {
    const next = colors.includes(c)
      ? colors.filter((x) => x !== c)
      : [...colors, c];
    onChange({ colorTag: serializeColors(next) });
  };

  const commitNote = () => {
    const trimmed = note.trim();
    if (trimmed === (prefs?.note || "")) return; // nothing actually changed
    onChange({ note: trimmed || null });
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <div ref={paletteRef} className="relative flex items-center gap-1.5">
        <span className="text-[0.65rem] text-muted">标记</span>

        {/* The same bookmarks the collapsed row shows, so the editor and the
            row are visibly the same thing rather than two notations. */}
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            disabled={disabled}
            onClick={() => toggleColor(c)}
            title="点击移除"
            className="transition-transform hover:scale-110 disabled:opacity-40"
          >
            <Bookmark color={c} size={12} />
          </button>
        ))}

        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border border-dashed text-[9px] leading-none transition-colors disabled:opacity-40 ${
            open
              ? "border-accent text-accent"
              : "border-border text-muted hover:border-accent hover:text-accent"
          }`}
          title="添加颜色标记"
        >
          {open ? "−" : "+"}
        </button>

        {open ? (
          <div className="absolute left-0 top-full z-20 mt-1.5 flex items-center gap-1.5 rounded border border-border bg-surface px-2 py-1.5 shadow-lg">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => toggleColor(c)}
                className={`h-3.5 w-3.5 rounded-full transition-transform hover:scale-125 ${
                  colors.includes(c) ? "ring-2 ring-white/70" : "ring-1 ring-black/20"
                }`}
                style={{ background: c }}
              />
            ))}
          </div>
        ) : null}
      </div>

      <input
        ref={boxRef}
        type="text"
        value={note}
        disabled={disabled}
        maxLength={200}
        onChange={(e) => setNote(e.target.value)}
        onBlur={commitNote}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          // The card listens for w/s/space to seek and play; typing a note
          // must not drive the audio.
          e.stopPropagation();
        }}
        placeholder="备注…"
        className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-[0.7rem] text-theme placeholder:text-muted/60 focus:border-accent focus:outline-none disabled:opacity-40"
      />
    </div>
  );
}
