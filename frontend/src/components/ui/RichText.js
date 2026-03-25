"use client";

/**
 * Color name → hex mapping for inline bookmarks.
 * Usage in text: {red}, {blue}, {green}, etc.
 * Also supports raw hex: {#FF5733}
 */
const COLOR_MAP = {
  red: "#FF5733",
  blue: "#3498DB",
  green: "#2ECC71",
  yellow: "#F39C12",
  purple: "#9B59B6",
  crimson: "#E74C3C",
  teal: "#1ABC9C",
  pink: "#E91E63",
};

function BookmarkInline({ color, size = 14 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 20"
      fill={color}
      className="inline-block align-text-bottom"
      style={{ margin: "0 1px" }}
    >
      <path d="M2 0h12a2 2 0 0 1 2 2v18l-8-4-8 4V2a2 2 0 0 1 2-2z" />
    </svg>
  );
}

/**
 * Renders text with inline bookmark icons.
 * Replaces {colorName} or {#RRGGBB} with a colored bookmark SVG.
 *
 * Example: "My {red} playlist {blue}" renders as "My 🔖 playlist 🔖"
 */
export default function RichText({ text, className }) {
  if (!text) return null;

  const parts = [];
  const regex = /\{([a-zA-Z]+|#[0-9A-Fa-f]{6})\}/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const key = match[1];
    const hex = key.startsWith("#") ? key : COLOR_MAP[key.toLowerCase()];

    if (hex) {
      parts.push(<BookmarkInline key={match.index} color={hex} />);
    } else {
      // Unknown color name — keep as-is
      parts.push(match[0]);
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <span className={className}>{parts}</span>;
}

export { COLOR_MAP };
