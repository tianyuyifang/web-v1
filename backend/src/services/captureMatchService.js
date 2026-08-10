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

/**
 * normTitle without the bracket strip.
 *
 * The strip exists so "十年（Live）" matches "十年", but it cannot tell a
 * version marker from a subtitle: it also collapsed "挣脱 (Break Free)" into
 * "挣脱" and "海底 (Deep)" into "海底", which auto-approved a like for what may
 * be a different song. Titles that match only because brackets were removed
 * still match — they just no longer count as exact, so a human confirms them.
 */
function normTitleStrict(s) {
  return String(s == null ? '' : s)
    .normalize('NFC')
    .trim()
    .replace(/[《》]/g, '')
    .replace(/\s*[-–—]\s*(live|remix|inst|伴奏|翻唱|演唱会版?|现场版?|重制版?).*$/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * Fold full-width ASCII (U+FF01–U+FF5E) to its half-width twin, plus the
 * ideographic space. The game writes "暂停.开始过" where the library holds
 * "暂停．开始过" — same song, different punctuation width.
 *
 * Deliberately NOT String.normalize('NFKC'), which would also expand … into
 * "..." — and 18 library titles genuinely contain …, which splitEllipsis()
 * treats as "the game truncated this". NFKC would turn every one of them into
 * a false ellipsis match.
 */
function foldWidth(s) {
  return String(s == null ? '' : s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

/**
 * The same mapping as character pairs, for the SQL prefilter's translate().
 * Derived from foldWidth's own range so the two cannot drift apart — the
 * prefilter must fold whatever the matcher folds, or songs the matcher would
 * pair up never get fetched in the first place.
 */
const FOLD_FROM = Array.from({ length: 0xff5e - 0xff01 + 1 }, (_, i) =>
  String.fromCharCode(0xff01 + i)).join('') + '　';
const FOLD_TO = Array.from({ length: 0xff5e - 0xff01 + 1 }, (_, i) =>
  String.fromCharCode(0xff01 + i - 0xfee0)).join('') + ' ';

/** normTitle with punctuation width folded away. Used only for `punct` matches. */
function normTitleFolded(s) {
  return normTitle(foldWidth(String(s == null ? '' : s).normalize('NFC')));
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
 *   kind: 'exact'    identical without needing brackets removed
 *         'bracket'  identical only once bracketed text was stripped
 *         'punct'    identical once punctuation width is folded
 *         'ellipsis' captured was elided; prefix (and suffix) line up
 *         'loose'    one is a prefix of the other — extra words like
 *                    "演唱会版", " triangle"
 *
 * Only 'exact' is auto-approved by the UI. Everything else is a proposal the
 * user confirms by hand, so widening the looser kinds cannot cause a wrong
 * like — and a like is shared with everyone who can see the playlist.
 */
function compareTitles(captured, libraryTitle) {
  const a = normTitle(captured);
  const b = normTitle(libraryTitle);
  if (!a || !b) return null;

  if (a === b) {
    // Equal — but was it equal on its own, or only because the bracket strip
    // deleted something? "挣脱 (Break Free)" and "挣脱" collapse to the same
    // string, and auto-liking that assumes the bracket held a version marker
    // rather than part of the name. Let a human decide.
    if (normTitleStrict(captured) === normTitleStrict(libraryTitle)) {
      return { kind: 'exact', note: null };
    }
    return { kind: 'bracket', note: `括号内容不同，曲库里是「${libraryTitle}」` };
  }

  // Case 2 — the UI elided the middle of a long title.
  const ell = splitEllipsis(captured);
  if (ell && ell.prefix && b.startsWith(ell.prefix) && (!ell.suffix || b.endsWith(ell.suffix))) {
    return { kind: 'ellipsis', note: `游戏里显示为省略形式，曲库里是「${libraryTitle}」` };
  }

  // Case 2b — same title, different punctuation width ("暂停.开始过" vs
  // "暂停．开始过"). Checked AFTER the exact test and reported as its own kind,
  // so folding never widens what counts as exact — these still need a human.
  if (normTitleFolded(captured) === normTitleFolded(libraryTitle)) {
    return { kind: 'punct', note: `标点写法不同，曲库里是「${libraryTitle}」` };
  }

  // An elided capture must not fall through to prefix matching: "Rolling
  // I...e Deep" starts with "roll", so the loose branch happily proposed the
  // unrelated song "Roll". If the game truncated the title, the ellipsis
  // branch above is the only sound way to match it.
  if (ell) return null;

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
    ? `曲库多了「${extra}」`
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
const KIND_RANK = { exact: 0, bracket: 1, punct: 2, ellipsis: 3, loose: 4 };

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

module.exports = {
  normTitle, normTitleFolded, foldWidth, splitEllipsis, compareTitles, matchTitle,
  FOLD_FROM, FOLD_TO,
};
