/**
 * Keys for the game-song -> playable-id mapping.
 *
 * A mapping is keyed on (title, artist) TOGETHER. The artist is part of the
 * key, never an attribute: 致青春/王菲 and 致青春/李宇春 are different songs, and
 * a lookup by title alone would collide them. Nothing here exposes a
 * title-only key for that reason — the one place that legitimately searches by
 * title alone (matching against imported tracks when the game and the platform
 * disagree about the artist) queries the title_key column directly and is
 * expected to handle several hits.
 *
 * Title normalisation is deliberately NOT reimplemented here. captureMatchService
 * already does it, its rules were learned from real game data, and auto-tagging
 * runs on them in production — so this file borrows normTitle/foldWidth and adds
 * only what is new: artist keys. Changing normTitle's behaviour would silently
 * change which songs auto-tagging likes, so it stays untouched.
 */
const { normTitle, foldWidth } = require('./captureMatchService');

/**
 * Separators between co-performers. The game writes 汪苏泷/赵露思, the library
 * uses 周杰伦_费玉清, and platforms use commas or ampersands.
 *
 * `_` is in here because it is this project's own artist separator, but it is
 * also a character that appears inside a few real artist names. Splitting on it
 * is a guess, and isSeparatorAmbiguous() below exists so callers can find out
 * when the guess was load-bearing and route the row to a human instead.
 */
const ARTIST_SPLIT = /[/／、,，&＆_]|\s+feat\.?\s+|\s+ft\.?\s+/i;

/**
 * Normalise one artist name: width-folded, case-flattened, whitespace removed.
 *
 * Mixed-script names (朱婧汐 Akini Jing) keep both halves. Dropping the Latin
 * part would be tempting for matching but would fuse two artists who share a
 * Chinese name, and a wrong fusion is unrecoverable — it silently plays the
 * wrong song forever, whereas a missed match merely queues for review.
 */
function normOneArtist(s) {
  return foldWidth(String(s == null ? '' : s))
    .normalize('NFC')
    .replace(/[（(【[].*?[）)】\]]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * Split an artist string into its parts, dropping empties.
 * Order is not preserved — see artistKey.
 */
function splitArtists(s) {
  return String(s == null ? '' : s)
    .split(ARTIST_SPLIT)
    .map(normOneArtist)
    .filter(Boolean);
}

/**
 * Normalised artist key: parts sorted and rejoined with '|'.
 *
 * Sorting is what makes 汪苏泷/赵露思 and 赵露思/汪苏泷 one key. Platforms and the
 * game order co-performers differently and neither order is authoritative, so
 * an unsorted key would split one song into two mappings that each look correct.
 */
function artistKey(s) {
  // Locale-independent sort: the key is compared byte-for-byte against what
  // another machine stored, so it must not depend on the server's locale.
  return splitArtists(s).sort().join('|');
}

/** Normalised title key. Same rules auto-tagging already matches on. */
function titleKey(s) {
  return normTitle(foldWidth(String(s == null ? '' : s)));
}

/**
 * Both halves of a mapping key, plus the raw forms.
 *
 * Raw values are stored alongside the keys so the review page can show what
 * the game actually said, and so every row can be re-keyed if these rules ever
 * change. Without them a normalisation fix would need the game data again.
 */
function songKey(title, artist) {
  return {
    titleKey: titleKey(title),
    artistKey: artistKey(artist),
    rawTitle: String(title == null ? '' : title).trim(),
    rawArtist: String(artist == null ? '' : artist).trim(),
  };
}

/**
 * True when splitting this artist string was a guess worth checking.
 *
 * Every separator we split on also occurs inside real artist names — AC/DC,
 * Simon & Garfunkel, 周杰伦_费玉清 where `_` is both this project's separator
 * and a character some names contain. No rule tells "two artists" apart from
 * "one artist whose name contains a slash", so rather than pick silently,
 * callers use this to route the row to a human.
 *
 * `known` is the set of normalised artist keys a human has already approved.
 * Once every part is recognised the split is safe, so confirming a name once
 * retires the question for good.
 *
 * Only single-separator strings are flagged. 封茗囧菌/双笙 with two performers
 * is what the separator is for and reads as a genuine list, whereas a lone
 * separator is the shape that both readings fit.
 */
function isSeparatorAmbiguous(artist, known = new Set()) {
  const raw = String(artist == null ? '' : artist).trim();
  if (!raw) return false;

  const hits = raw.match(new RegExp(ARTIST_SPLIT.source, 'gi'));
  if (!hits) return false;

  const parts = splitArtists(raw);
  // A leading or trailing separator leaves one part: it was decoration, not a
  // split ("A_", "_B").
  if (parts.length < 2) return true;
  // Every part already vouched for by a human — nothing left to guess.
  if (parts.every((p) => known.has(p))) return false;
  // A single separator is the ambiguous shape; a real list usually has more
  // context (several separators) or has been approved before.
  return hits.length === 1;
}

/**
 * Do two artist strings refer to the same performer(s)?
 *
 * Deliberately looser than key equality, because the game and the platforms
 * disagree constantly: the game says 凤凰传奇 where QQ says 玲花/曾毅, and
 * platforms add or drop featured artists at will. Overlap of one name is
 * treated as agreement.
 *
 * This never decides playback on its own — it only ranks candidates and
 * chooses which ones a human sees first.
 */
function artistsOverlap(a, b) {
  const setA = new Set(splitArtists(a));
  const setB = new Set(splitArtists(b));
  if (!setA.size || !setB.size) return false;
  for (const x of setA) if (setB.has(x)) return true;
  return false;
}

module.exports = {
  titleKey,
  artistKey,
  songKey,
  splitArtists,
  normOneArtist,
  artistsOverlap,
  isSeparatorAmbiguous,
  ARTIST_SPLIT,
};
