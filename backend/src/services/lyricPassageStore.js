/**
 * Verified answers for lyric passages.
 *
 * The 唱卡 page matches the game's passage against the platform's lyrics on its
 * own, and gets 91% of lines right. The rest is not a threshold to tune: the
 * two sides break lines differently, so the game's 「那个傻瓜说的傻话」 is the
 * platform's 「那个傻瓜」 plus 「说的傻话」. Working that out takes reading the
 * words, so the answers are decided once and looked up here.
 *
 * The contract with the page is deliberately narrow: this returns an answer or
 * it returns null. Only an approved row answers — pending suggestions and
 * passages known to be unmatchable both return null, and so does any failure —
 * because null means "run the matcher", which is exactly what the page does
 * today. The page can therefore only get better, never worse.
 */
const crypto = require('crypto');
const prisma = require('../db/client');

/**
 * Identify a passage by its exact text.
 *
 * Shuffled lines and different masking hash differently on purpose: the answer
 * is an array parallel to the game's own lines, so a reordered passage needs
 * its own answer, and a differently-masked read carries different evidence.
 */
function hashPassage(gameLyric) {
  return crypto.createHash('sha1')
    .update(String(gameLyric == null ? '' : gameLyric).trim())
    .digest('hex')
    .slice(0, 16);
}

/**
 * Every real line an answer covers, flattened.
 *
 * An entry is a line index, or a list of them where the platform wrote as
 * several lines what the game showed as one — 「你是一只飞鸟飞上我的树梢」 is
 * 「你是一只飞鸟」 plus 「飞上我的树梢」. -1 records a line with no counterpart.
 */
function coveredLines(answer) {
  const out = [];
  answer.forEach((v) => {
    if (Array.isArray(v)) v.forEach((n) => { if (n >= 0) out.push(n); });
    else if (v >= 0) out.push(v);
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

/** One entry: a line index, a non-empty list of them, or -1 for "no counterpart". */
function entryOk(v) {
  if (Number.isInteger(v)) return v >= -1;
  if (!Array.isArray(v) || !v.length) return false;
  return v.every((n) => Number.isInteger(n) && n >= 0);
}

/**
 * An answer is one placement, or a list of them.
 *
 * A passage is usually sung more than once — 58% of measured passages occur at
 * least twice, a chorus commonly three or four times. The page marks every
 * occurrence and draws a dot per occurrence on the progress bar, so an answer
 * naming only the first would quietly take those away.
 *
 * One placement is written as a flat array (`[12, 13, 14]`); several as an array
 * of those (`[[12,13,14],[40,41,42]]`).
 *
 * Neither the count nor the nesting alone tells them apart, and some answers are
 * genuinely readable both ways. `[[5,6],[22,23]]` for a two-line passage is
 * either two placements of two lines, or one placement whose two lines each span
 * two real lines. `[[4,5],[5,6,7],[7,8],…]` — 「第一天」, written one-to-many
 * throughout — is six entries that look exactly like six placements.
 *
 * Contiguity resolves it, because it is the one rule a wrong reading breaks. As
 * one placement, `[[5,6],[22,23]]` covers 5,6,22,23 with a hole in it; as two,
 * each is a run. So try each reading and keep the one that holds together.
 *
 * When both readings hold, one placement wins, because a single run of adjacent
 * lines is the stronger claim. 「我想你要走了」 is stored `[[11,12],[13,14]]` for
 * two game lines: 「你要告别了把话说好了」 is line [11] plus line [12], and
 * 11-14 is one continuous passage the singer moves through once. Read as two
 * placements it would put two dots on the progress bar for one occurrence.
 */
function runOk(place, lineCount) {
  if (!Array.isArray(place) || !place.length) return false;
  if (lineCount != null && place.length !== lineCount) return false;
  if (!place.every(entryOk)) return false;
  const used = coveredLines(place);
  if (!used.length) return true;
  return used[used.length - 1] - used[0] === used.length - 1;
}

function placementsOf(answer, lineCount) {
  if (!Array.isArray(answer) || !answer.length) return [];
  if (runOk(answer, lineCount)) return [answer];
  if (answer.every((p) => runOk(p, lineCount))) return answer;
  // Neither reading holds. Return the one the author most likely meant, so a
  // caller reporting the problem reports it against that; both are unusable.
  if (lineCount != null && answer.length === lineCount) return [answer];
  const several = answer.every((p) => Array.isArray(p) && p.length && p.every(entryOk));
  return several ? answer : [answer];
}

/**
 * Is this a usable answer for a passage of this many lines?
 *
 * Checked on the way out as well as on the way in. A row whose length no longer
 * matches — the game changed what it shows, or an import went in wrong — would
 * misalign every line after the discrepancy, and highlighting the wrong lines
 * is worse than highlighting none. Rejecting it here falls back to the matcher.
 */
function isUsable(answer, lineCount) {
  if (!Array.isArray(answer) || !answer.length) return false;
  // Every placement must be a run of its own — `runOk` is the same check
  // `placementsOf` used to choose the reading, so an answer is usable exactly
  // when one of its two readings held.
  //
  // Contiguity is worth this much machinery because it caught a real mistake:
  // where the platform wrote as two lines what the game showed as one, answers
  // were recorded pointing only at the first, leaving the second unhighlighted
  // and the run with a hole in it. Six of the first twenty-seven were wrong
  // that way — which is what the list form of an entry exists to express.
  return placementsOf(answer, lineCount).every((place) => runOk(place, lineCount));
}

/**
 * The verified answer for this passage, or null to fall through to the matcher.
 *
 * @param {string} source      SongSource, as stored on the mapping
 * @param {string} externalId  platform id, as stored on the mapping
 * @param {string} gameLyric   the passage exactly as the game showed it
 * @param {number} [lineCount] how many lines the caller split it into
 */
async function getApproved(source, externalId, gameLyric, lineCount) {
  if (!source || !externalId || !gameLyric) return null;
  try {
    const row = await prisma.lyricPassageMatch.findUnique({
      where: {
        source_externalId_lyricHash: {
          source,
          externalId: String(externalId),
          lyricHash: hashPassage(gameLyric),
        },
      },
      select: { answer: true, status: true },
    });
    if (!row || row.status !== 'approved') return null;
    return isUsable(row.answer, lineCount) ? row.answer : null;
  } catch (err) {
    // The table may not exist yet on an older database, or the query may fail
    // under load. Either way the page has a matcher of its own; saying nothing
    // is the same as never having been asked.
    console.warn('[lyric-passage] lookup unavailable:', err.message);
    return null;
  }
}

/**
 * A singer pressed 「段落点不准确」 on this passage.
 *
 * Counting, not judging: the row's status is left alone. A report on an
 * approved answer must not demote it — a stray tap would undo a human's work
 * — so it only raises the count, and the review page flags the row for a
 * person to look at. A passage never seen before becomes a pending row with
 * an empty answer: nothing is proposed yet, and an empty answer can never be
 * served (isUsable refuses it), so filing the report costs the page nothing.
 *
 * verifiedBy is 'report' on such rows: not the assistant's work, not a
 * human's — provenance for the review page, overwritten the moment a
 * reviewer decides.
 */
async function report(source, externalId, gameLyric) {
  if (!source || !externalId || !gameLyric || !String(gameLyric).trim()) {
    return { ok: false };
  }
  const key = {
    source,
    externalId: String(externalId),
    lyricHash: hashPassage(gameLyric),
  };
  const bump = {
    reportCount: { increment: 1 },
    lastReportedAt: new Date(),
  };
  try {
    await prisma.lyricPassageMatch.update({
      where: { source_externalId_lyricHash: key }, data: bump,
    });
    return { ok: true };
  } catch (err) {
    if (err.code !== 'P2025') throw err;
  }
  try {
    await prisma.lyricPassageMatch.create({
      data: {
        ...key,
        gameLyric: String(gameLyric),
        answer: [],
        status: 'pending',
        verifiedBy: 'report',
        reportCount: 1,
        lastReportedAt: new Date(),
      },
    });
  } catch (err) {
    // Two singers reporting the same new passage at once: the loser of the
    // race just counts on the winner's row.
    if (err.code !== 'P2002') throw err;
    await prisma.lyricPassageMatch.update({
      where: { source_externalId_lyricHash: key }, data: bump,
    });
  }
  return { ok: true };
}

module.exports = {
  hashPassage, isUsable, getApproved, coveredLines, placementsOf, report,
};
