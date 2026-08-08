/**
 * Capture text -> song matching.
 *
 * qni's tv_songName gives a title and nothing else — no artist. So this
 * resolves a bare title against the library and hands back candidates for
 * the user to approve. Nothing here likes anything; matching only proposes.
 *
 * Three real-world cases this handles (observed in the game):
 *   1. exact    "山海"            == "山海"
 *   2. ellipsis "三角体…triangle"  -> title elided mid-string by the UI
 *   3. loose    "十年"            vs "十年（Live）" / "十年 演唱会版"
 *               "三角体"          vs "三角体 triangle"   (extra words)
 *
 * Every non-exact match is flagged so the UI can show what differs and let
 * the user judge. A wrong proposal is harmless — it just doesn't get approved.
 */

/**
 * Normalise a title for comparison: strip 《》, bracketed suffixes like
 * （Live）, trailing -live/-remix markers, all whitespace, and case.
 */
function normTitle(s) {
  return String(s == null ? '' : s)
    .normalize('NFC')
    .trim()
    .replace(/[《》]/g, '')
    .replace(/[（(【[].*?[）)】\]]/g, '')
    .replace(/\s*[-–—]\s*(live|remix|inst|伴奏|翻唱|演唱会版?|现场版?|重制版?).*$/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** Tails that mark a version of the same song rather than a different song. */
const VERSION_TAIL = /^(live|remix|inst|acoustic|演唱会版?|现场版?|伴奏|翻唱|重制版?|粤语版?|国语版?|完整版?|前奏版?|dj.*版?)$/i;

/** Split "前缀…后缀" on an ellipsis. Returns null when there is none. */
function splitEllipsis(s) {
  const m = /^(.*?)(?:\.{2,}|…+)(.*)$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  return { prefix: normTitle(m[1]), suffix: normTitle(m[2]) };
}

/**
 * Compare a captured title against a library title.
 * Returns { kind, note } or null when they are unrelated.
 *
 *   kind: 'exact'    identical after normalisation
 *         'ellipsis' captured was elided; prefix (and suffix) line up
 *         'loose'    one is a prefix of the other — extra words like
 *                    "（Live）", "演唱会版", " triangle"
 */
function compareTitles(captured, libraryTitle) {
  const a = normTitle(captured);
  const b = normTitle(libraryTitle);
  if (!a || !b) return null;

  if (a === b) return { kind: 'exact', note: null };

  // Case 2 — the UI elided the middle of a long title.
  const ell = splitEllipsis(captured);
  if (ell && ell.prefix && b.startsWith(ell.prefix) && (!ell.suffix || b.endsWith(ell.suffix))) {
    return { kind: 'ellipsis', note: `游戏里显示为省略形式，库里是「${libraryTitle}」` };
  }

  // Case 3 — one side carries extra words ("（Live）", " triangle", "演唱会版").
  //
  // Two guards, both learned from real data:
  //   - the shorter side needs >= 3 chars, so "十" cannot prefix-match everything
  //   - the extra part needs >= 2 chars, because a one-character difference is
  //     usually a *different song* rather than a version marker
  //     (matched "山海" -> "山海侧" before this guard existed)
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const extra = long.slice(short.length);
  const noteFor = () => (a.length <= b.length
    ? `库里多了「${extra}」`
    : `游戏里多了「${extra}」`);

  if (long.startsWith(short) && extra.length >= 2) {
    if (short.length >= 3) return { kind: 'loose', note: noteFor() };
    // A 2-char title is too short to prefix-match safely ("山海" -> "山海侧"),
    // so only accept it when the tail is a recognisable version marker.
    // Keeps "十年" -> "十年 演唱会版" working without opening the floodgates.
    if (short.length === 2 && VERSION_TAIL.test(extra)) {
      return { kind: 'loose', note: noteFor() };
    }
  }

  return null;
}

/** Rank so the safest proposal surfaces first. */
const KIND_RANK = { exact: 0, ellipsis: 1, loose: 2 };

/**
 * Pick candidates from a list of library songs.
 *
 * @param {string} captured   raw title read from the game
 * @param {Array}  songs      [{ id, title, artist }]
 * @returns {{ outcome, candidates }}
 *   outcome 'pending'   exactly one candidate — show it for approval
 *           'ambiguous' several candidates — user picks one
 *           'no_match'  nothing resembled it
 */
function matchTitle(captured, songs) {
  const scored = [];
  for (const s of songs || []) {
    const cmp = compareTitles(captured, s.title);
    if (!cmp) continue;
    scored.push({
      songId: s.id,
      title: s.title,
      artist: s.artist,
      kind: cmp.kind,
      note: cmp.note,
    });
  }

  if (!scored.length) return { outcome: 'no_match', candidates: [] };

  scored.sort((x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind]);

  // Prefer exact matches outright: if any title matches exactly, looser
  // matches are noise and would only make the user's choice harder.
  const exact = scored.filter((x) => x.kind === 'exact');
  const finalists = exact.length ? exact : scored;

  return {
    outcome: finalists.length === 1 ? 'pending' : 'ambiguous',
    candidates: finalists,
  };
}

module.exports = { normTitle, splitEllipsis, compareTitles, matchTitle };
