/**
 * How to read a verified passage answer.
 *
 * An answer says where a game passage sits in the platform's lyrics. It is one
 * placement, or a list of them — a passage is usually sung more than once, and
 * both the 唱卡 page and the review page have to agree on which, or the page
 * marks lines the reviewer never approved.
 *
 * Kept beside the two of them rather than copied into each, because the reading
 * is not obvious: some answers are genuinely readable both ways and only
 * contiguity settles them. Mirrors `backend/src/services/lyricPassageStore.js`.
 */

/**
 * 归一化人工「首末」答案为逐行数组。
 *
 * 唱卡页只要每处的首末: 标黄整段区间、黄点落首行。admin 存的是
 * { ranges: [[first,last], ...] }, 这里就地展开成 [[first..last], ...] ——
 * 一个合法的多处逐行答案, 之后所有判定/渲染原样走旧逻辑, 新旧殊途同归到
 * 同一套代码, 渲染必然一致。非 ranges(算法/历史逐行数组)原样返回。
 */
export function isRangeAnswer(answer) {
  return Boolean(answer && !Array.isArray(answer) && Array.isArray(answer.ranges));
}

export function normaliseAnswer(answer) {
  if (!isRangeAnswer(answer)) return answer;
  return answer.ranges
    .filter((r) => Array.isArray(r) && r.length === 2
      && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] <= r[1])
    .map((r) => {
      const out = [];
      for (let i = r[0]; i <= r[1]; i += 1) out.push(i);
      return out;
    });
}

/** The real lines one entry covers. -1 means the game line has no counterpart. */
export function entryLines(v) {
  if (Array.isArray(v)) return v.filter((n) => n >= 0);
  return v >= 0 ? [v] : [];
}

/** One entry: a line index, a non-empty list of them, or -1. */
export function entryOk(e) {
  return Number.isInteger(e)
    || (Array.isArray(e) && e.length > 0 && e.every(Number.isInteger));
}

/**
 * Is this one placement of a passage of this many lines?
 *
 * One entry per game line, every entry well-formed, and the real lines it
 * covers adjacent — a passage is sung as a run, so the lines under it are a
 * block. That last rule is what distinguishes a genuine placement from a
 * coincidence, and what makes an ambiguous answer readable.
 */
export function runOk(place, lineCount) {
  if (!Array.isArray(place) || !place.length) return false;
  if (lineCount != null && place.length !== lineCount) return false;
  if (!place.every(entryOk)) return false;
  const used = [...new Set(place.flatMap(entryLines))].sort((a, b) => a - b);
  if (!used.length) return true;
  return used[used.length - 1] - used[0] === used.length - 1;
}

/**
 * The placements an answer names.
 *
 * One placement is written flat (`[12,13,14]`), several as a list of those
 * (`[[12,13,14],[40,41,42]]`), and an entry may itself be a list where the
 * platform wrote as two lines what the game showed as one — 「你是一只飞鸟飞上
 * 我的树梢」 is 「你是一只飞鸟」 plus 「飞上我的树梢」.
 *
 * Neither nesting nor length alone separates those. `[[5,6],[22,23]]` for a
 * two-line passage reads as two placements or as one whose lines each span two;
 * 「第一天」, one-to-many throughout, is six entries shaped exactly like six
 * placements. Contiguity decides, because a wrong reading breaks it: read as one
 * placement, `[[5,6],[22,23]]` covers 5,6,22,23 with a hole in it.
 *
 * So try both readings and keep the one that holds together. When both do, one
 * placement wins — a single run of adjacent lines is the stronger claim.
 * 「我想你要走了」 is stored `[[11,12],[13,14]]` for two game lines: the first is
 * line [11] plus line [12], and 11-14 is one passage the singer moves through
 * once. Read as two placements it would draw two progress-bar dots for one
 * occurrence.
 */
export function placementsOf(rawAnswer, lineCount) {
  const lc = isRangeAnswer(rawAnswer) ? null : lineCount;
  const answer = normaliseAnswer(rawAnswer);
  if (!Array.isArray(answer) || !answer.length) return [];
  if (runOk(answer, lc)) return [answer];
  if (answer.every((p) => runOk(p, lc))) return answer;
  // Neither reading holds. Return the likelier one so a caller that reports the
  // problem reports it against what the author meant; both are unusable.
  if (lc != null && answer.length === lc) return [answer];
  const several = answer.every((p) => Array.isArray(p) && p.length && p.every(entryOk));
  return several ? answer : [answer];
}

/** Is the whole answer usable for a passage of this many lines? */
export function isUsable(rawAnswer, lineCount) {
  const lc = isRangeAnswer(rawAnswer) ? null : lineCount;
  const answer = normaliseAnswer(rawAnswer);
  if (!Array.isArray(answer) || !answer.length) return false;
  return placementsOf(rawAnswer, lineCount).every((p) => runOk(p, lc));
}
