"use client";

/**
 * Play, pause and busy, as shapes rather than characters.
 *
 * These were `▶` and `❚❚`, which are text, and Apple platforms render both as
 * emoji: colourful, glyph-sized to their own metrics, and sitting wherever the
 * emoji font's baseline puts them rather than in the middle of the button. The
 * `leading-8` trick used to centre them works on letters and not on those, so
 * on iOS and macOS the icons came out large, tinted, and off-centre.
 *
 * SVG has none of that. It takes `currentColor`, it is exactly the size it is
 * told to be, and it is centred by the flex box around it rather than by a
 * line-height that assumes text metrics.
 *
 * `aria-hidden` throughout: the button carries the label, and a screen reader
 * announcing a decorative triangle would be repeating it.
 */

function Icon({ children, className = "" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={`h-3.5 w-3.5 ${className}`}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Nudged right by a hair: a triangle's optical centre is left of its bounding box. */
export function PlayIcon({ className }) {
  return (
    <Icon className={`translate-x-[1px] ${className || ""}`}>
      <path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5z" />
    </Icon>
  );
}

export function PauseIcon({ className }) {
  return (
    <Icon className={className}>
      <rect x="7" y="5" width="3.5" height="14" rx="1.2" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1.2" />
    </Icon>
  );
}

/**
 * Working on it — a ring with a gap, turning.
 *
 * The three dots this replaces were also a character (`…`), with the same
 * problem, and they said nothing about progress. A spinner reads as "wait"
 * without being read.
 */
export function BusyIcon({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-3.5 w-3.5 animate-spin ${className || ""}`}
      aria-hidden="true"
    >
      <circle
        cx="12" cy="12" r="9"
        fill="none" stroke="currentColor" strokeWidth="2.5"
        strokeOpacity="0.25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none" stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A card with nothing to play. A dash, but one that centres like the others. */
export function UnmappedIcon({ className }) {
  return (
    <Icon className={className}>
      <rect x="5" y="11" width="14" height="2" rx="1" />
    </Icon>
  );
}
