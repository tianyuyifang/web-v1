"use client";

import { useState, useRef, useEffect, memo } from "react";

const PRESET_COLORS = [
  "#E8655A", // red
  "#E5A030", // orange/yellow
  "#4CAF50", // green
  "#5A8FD4", // blue
  "#8B6CC1", // purple
  "#D46B8C", // pink
];

function parseColors(colorTag) {
  if (!colorTag) return [];
  return colorTag.split("|").filter(Boolean);
}

function serializeColors(colors) {
  return colors.length > 0 ? colors.join("|") : null;
}

function BookmarkSVG({ color, size = 18 }) {
  return (
    <svg width={size} height={Math.round(size * 28 / 18)} viewBox="0 0 18 28" style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.12))" }}>
      <path d="M0 0h18v23l-9-5-9 5V0z" fill={color} />
    </svg>
  );
}

export default memo(function ColorTag({ color, editable, onChange }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const cornerRef = useRef(null);
  const selected = parseColors(color);

  // Close palette on outside click
  useEffect(() => {
    if (!paletteOpen) return;
    const handleClick = (e) => {
      if (cornerRef.current && !cornerRef.current.contains(e.target)) {
        setPaletteOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [paletteOpen]);

  const addColor = (c) => {
    if (!selected.includes(c)) {
      onChange(serializeColors([...selected, c]));
    }
  };

  const removeColor = (c) => {
    onChange(serializeColors(selected.filter((s) => s !== c)));
  };

  // Read-only mode: just show flags
  if (!editable) {
    if (selected.length === 0) return null;
    return (
      <div className="absolute right-4 top-0 z-10 flex items-start gap-1.5">
        {selected.map((c) => (
          <div key={c} className="animate-bookmark-drop">
            <BookmarkSVG color={c} />
          </div>
        ))}
      </div>
    );
  }

  // Editable mode: + button, palette, and removable flags
  return (
    <div ref={cornerRef} className="absolute right-4 top-0 z-10 flex items-start gap-1.5">
      {/* Add button */}
      <button
        onClick={() => setPaletteOpen((v) => !v)}
        className={`mt-0.5 flex h-[22px] w-[18px] shrink-0 items-center justify-center rounded-sm text-[10px] leading-none transition-all ${
          paletteOpen
            ? "border border-solid border-primary text-primary"
            : "border border-dashed border-border text-muted opacity-25 hover:border-primary hover:text-primary hover:opacity-100"
        }`}
      >
        {paletteOpen ? "−" : "+"}
      </button>

      {/* Color palette dropdown */}
      {paletteOpen && (
        <div className="mt-1 flex items-center gap-1">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => addColor(c)}
              className="h-3 w-3 rounded-sm transition-transform hover:scale-125"
              style={{ background: c }}
            />
          ))}
        </div>
      )}

      {/* Bookmark flags */}
      {selected.map((c) => (
        <div
          key={c}
          className="group relative animate-bookmark-drop cursor-pointer"
          onClick={() => removeColor(c)}
        >
          <BookmarkSVG color={c} />
          <div className="absolute inset-0 opacity-0 group-hover:opacity-75 transition-opacity" />
        </div>
      ))}
    </div>
  );
})
