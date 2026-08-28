"use client";

import { memo, useEffect, useRef, useState } from "react";
import { PRESET_COLORS } from "../player/ColorTag";

/**
 * A singer's own marks on a 唱卡 card: colour flags and a note.
 *
 * Not ColorTag, though it shares that component's palette and its
 * pipe-separated storage. ColorTag is a bookmark pinned to the top-right
 * corner of a playlist row by absolute positioning, and it drops in with an
 * animation; this sits inline in a header line that already carries a title,
 * a stage label and a confirmation badge, where a corner-anchored flag would
 * land on top of them.
 *
 * Dots, not bookmarks. The silhouette was tried here and reads as clutter at
 * this size — a bookmark is a shape you hang off an edge, and inline among
 * text it just competes with the title. A dot is a mark, which is what these
 * are. The colours still mean the same thing in both places, which is the
 * part worth sharing.
 */

/**
 * One colour mark.
 *
 * A ring rather than a border: it sits on top of the fill instead of eating
 * into it, so a small dot keeps its full colour while still being separated
 * from whatever it sits on. Without it a dark mark on a dark card has no edge
 * at all.
 *
 * White at 20%, not black at 25%. Black is invisible against a dark card --
 * the case the ring exists for -- and on a light one it renders as #BFBFBF, a
 * grey outline around a 10px dot, where 1px of ring is a fifth of what you
 * see. White inverts both: it separates the dot from a dark card properly, and
 * disappears into a white one, which needed no help to begin with. Seven
 * accounts are on the dark theme, so the dark case is real and cannot just be
 * dropped.
 */
function Dot({ color, className = "" }) {
  return (
    <span
      className={`h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/20 ${className}`}
      style={{ background: color }}
      aria-hidden="true"
    />
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
        <span className="flex shrink-0 items-center gap-1">
          {colors.map((c) => (
            <Dot key={c} color={c} />
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

        {/* The same marks the collapsed row shows, so the editor and the row
            are visibly the same thing rather than two notations. */}
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            disabled={disabled}
            onClick={() => toggleColor(c)}
            title="点击移除"
            className="flex items-center transition-transform hover:scale-110 disabled:opacity-40"
          >
            <Dot color={c} />
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
                className={`h-3 w-3 rounded-full transition-transform hover:scale-125 ${
                  colors.includes(c) ? "ring-2 ring-white/70" : "ring-1 ring-white/20"
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
