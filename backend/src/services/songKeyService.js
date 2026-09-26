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
 * runs on them in production — so this file borrows normTitle/foldWidth for the
 * pool's title key, and adds what is new: artist keys, the mapping's own title
 * key and a version comparison. Changing normTitle's behaviour would silently
 * change which songs auto-tagging likes, so it stays untouched.
 *
 * Two title keys, for two columns: titleKey (loose, normTitle) keys the imported
 * pool, mappingTitleKey (the game's text as-is) keys song_mappings. See each.
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

/**
 * Normalised title key for the imported POOL (imported_tracks.title_key).
 * Same rules auto-tagging already matches on.
 *
 * Loose on purpose: it strips bracketed suffixes, so 十年 and 十年(Live) share a
 * key. That is right for the pool — claiming a track and listing "other
 * versions of this song" both want every recording of a title together. It is
 * wrong for a mapping's identity, which is what mappingTitleKey is for.
 */
function titleKey(s) {
  return normTitle(foldWidth(String(s == null ? '' : s)));
}

/**
 * Title key for a MAPPING's identity (song_mappings.title_key) — the game's own
 * text, not normalised.
 *
 * A mapping answers "which recording plays when the game shows this", and the
 * game shows versions apart: 无眠 and 无眠(国语版), 知足 and 知足(乐团版) are
 * different songs that each need their own source. The loose titleKey above
 * folded them into one key, so the unique (titleKey, artistKey) constraint let
 * only one of each pair exist and the other silently played its sibling.
 *
 * So only two things are removed: outer whitespace, and 《》 — kept as it was,
 * since it is a decoration around a title rather than part of it. Brackets,
 * case, width and inner spaces all survive. NFC is not normalisation in that
 * sense: it only makes one character's two byte encodings compare equal.
 *
 * Every place that reads or writes song_mappings.title_key must use this, and
 * every place that reads imported_tracks.title_key must use titleKey — the two
 * columns are keyed by different rules now.
 */
function mappingTitleKey(s) {
  return String(s == null ? '' : s)
    .normalize('NFC')
    .trim()
    .replace(/[《》]/g, '')
    .trim();
}

/**
 * Title with its version kept but its formatting folded — for asking "is this
 * track the same VERSION the game named", never stored as a key.
 *
 * Brackets and "- Live" style suffixes count (无眠 vs 无眠(国语版), 十年 vs
 * 十年 - Live are different recordings). Case, width and spacing do not
 * (God Is a Girl vs God Is A Girl is one recording spelled two ways), or the
 * check would flag platforms' cosmetic differences as version changes.
 */
function versionTitleKey(s) {
  return foldWidth(String(s == null ? '' : s))
    .normalize('NFC')
    .trim()
    .replace(/[《》]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
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
    titleKey: mappingTitleKey(title),
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
  mappingTitleKey,
  versionTitleKey,
  artistKey,
  songKey,
  splitArtists,
  normOneArtist,
  artistsOverlap,
  isSeparatorAmbiguous,
  ARTIST_SPLIT,
};
