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
 * Is this a usable answer for a passage of this many lines?
 *
 * Checked on the way out as well as on the way in. A row whose length no longer
 * matches — the game changed what it shows, or an import went in wrong — would
 * misalign every line after the discrepancy, and highlighting the wrong lines
 * is worse than highlighting none. Rejecting it here falls back to the matcher.
 */
function isUsable(answer, lineCount) {
  if (!Array.isArray(answer)) return false;
  if (lineCount != null && answer.length !== lineCount) return false;
  if (!answer.every((v) => Number.isInteger(v) && v >= -1)) return false;

  // The lines it covers must be adjacent. A passage is sung as a run, so the
  // real lines under it are a block — the matcher enforces this too, and it is
  // the one rule that tells a genuine placement from a coincidence.
  //
  // Checked here because it caught a real mistake: where the platform wrote as
  // two lines what the game showed as one, answers were recorded pointing only
  // at the first, leaving the second unhighlighted and the run with a hole in
  // it. Six of the first twenty-seven were wrong that way.
  const used = [...new Set(answer.filter((v) => v >= 0))].sort((a, b) => a - b);
  if (!used.length) return true;
  return used[used.length - 1] - used[0] === used.length - 1;
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

module.exports = { hashPassage, isUsable, getApproved };
