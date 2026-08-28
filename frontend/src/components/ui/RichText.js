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
 * An image written as ![](/file.png).
 *
 * Only same-origin paths are drawn. A src pointing at another host would let
 * whoever writes the text pull in a picture nobody here controls, and would
 * report every reader's visit to that host — so anything else is left as the
 * literal text that was typed, which is visibly wrong rather than silently
 * doing something unintended.
 */
function isLocalImage(src) {
  if (typeof src !== "string") return false;
  // A single leading slash, and never two: "//host/x.png" is a
  // protocol-relative URL that loads from another origin while looking local.
  if (!src.startsWith("/") || src.startsWith("//")) return false;
  // No traversal — a path names a file under public/, not a route out of it.
  if (src.includes("..")) return false;
  return /^\/[\w-]+(?:\/[\w-]+)*\.(png|jpe?g|gif|webp|svg)$/i.test(src);
}

/**
 * Renders text with inline bookmark icons and images.
 *
 * Bookmarks: {colorName} or {#RRGGBB} become a coloured bookmark SVG.
 *   "My {red} playlist" renders as "My 🔖 playlist"
 * Images: ![](/file.png) becomes an <img>, on its own line.
 *
 * Images are matched first: their alt text could otherwise contain something
 * that looks like a bookmark and be eaten before the image is recognised.
 */
export default function RichText({ text, className }) {
  if (!text) return null;

  // Split on images first, then run the bookmark pass over the text between
  // them — the two syntaxes are independent and must not consume each other.
  const imageRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  const blocks = [];
  let imgLast = 0;
  let imgMatch;
  while ((imgMatch = imageRe.exec(text)) !== null) {
    if (imgMatch.index > imgLast) {
      blocks.push({ type: "text", value: text.slice(imgLast, imgMatch.index) });
    }
    blocks.push({
      type: isLocalImage(imgMatch[2]) ? "image" : "text",
      value: isLocalImage(imgMatch[2]) ? imgMatch[2] : imgMatch[0],
      alt: imgMatch[1] || "",
    });
    imgLast = imgMatch.index + imgMatch[0].length;
  }
  if (imgLast < text.length) blocks.push({ type: "text", value: text.slice(imgLast) });

  if (blocks.some((b) => b.type === "image")) {
    return (
      <span className={className}>
        {blocks.map((b, i) =>
          b.type === "image" ? (
            <img
              key={i}
              src={b.value}
              alt={b.alt}
              // Block, so an image sits on its own line rather than wedged into
              // a sentence, and capped so a large upload cannot run off a phone
              // or push the announcement below the fold.
              className="my-2 block h-auto max-w-[240px] rounded-lg border border-border"
              loading="lazy"
            />
          ) : (
            <RichTextInline key={i} text={b.value} />
          )
        )}
      </span>
    );
  }

  return <RichTextInline text={text} className={className} />;
}

/** The bookmark pass — the original behaviour, unchanged. */
function RichTextInline({ text, className }) {
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

