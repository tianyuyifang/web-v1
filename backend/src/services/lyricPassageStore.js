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
 * 归一化人工「首末」答案为逐行数组(与前端 passageAnswer 镜像)。
 * { ranges: [[first,last],...] } 展开成 [[first..last],...]; 非 ranges 原样返回。
 */
function isRangeAnswer(answer) {
  return Boolean(answer && !Array.isArray(answer) && Array.isArray(answer.ranges));
}

function normaliseAnswer(answer) {
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

function placementsOf(rawAnswer, lineCount) {
  const lc = isRangeAnswer(rawAnswer) ? null : lineCount;
  const answer = normaliseAnswer(rawAnswer);
  if (!Array.isArray(answer) || !answer.length) return [];
  if (runOk(answer, lc)) return [answer];
  if (answer.every((p) => runOk(p, lc))) return answer;
  // Neither reading holds. Return the one the author most likely meant, so a
  // caller reporting the problem reports it against that; both are unusable.
  if (lc != null && answer.length === lc) return [answer];
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
function isUsable(rawAnswer, lineCount) {
  const lc = isRangeAnswer(rawAnswer) ? null : lineCount;
  const answer = normaliseAnswer(rawAnswer);
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
  return placementsOf(rawAnswer, lineCount).every((place) => runOk(place, lc));
}

/**
 * 同一首歌里, 两段词是不是同一段的两种显示。
 *
 * 游戏对同一段词会换着花样出: 把句子打乱顺序, 或者把一部分字盖成 __。
 * 人确认过其中一种之后, 另一种其实指向真实歌词的同一片行 —— 答案是
 * { ranges: [[首,末]] }, 说的是真实歌词的位置, 跟游戏那边的顺序和遮掩都
 * 无关, 所以可以原样拿来用。
 *
 * 判定是精确的, 不是相似度: 行数必须一样, 遮掩型要求每行看得见的部分一致,
 * 乱序型要求句子集合完全相同。一首歌里真有两段不同的词时(《山楂树之恋》
 * 那样), 这三条一条都过不了, 自然分得开。
 *
 * 拿 30609 条真实抓取(去重 10081 段、3114 首歌)跑过: 2093 首含变体, 归并出
 * 2373 组, 最大一组 12 个段落全部核对无误; 另有 279 首被正确拆成多个独立组,
 * 说明不同的段落没有被并到一起。
 */
function passageLines(s) {
  return String(s == null ? '' : s).split('\n').map((x) => x.trim()).filter(Boolean);
}

/** 一行里看得见的字 —— 去掉遮掩和空白。 */
function visible(line) {
  return String(line).replace(/[_\s]+/g, '');
}

function hasMask(line) {
  return /_/.test(String(line));
}

/**
 * 遮掩变体: 行数相同, 且每一行看得见的部分相容。
 *
 * 「相容」不是相等: 被盖住的那行只剩前几个字, 所以要求它是另一行的前缀。
 * 至少有一行带遮掩才算 —— 两行完全一样的不走这里, 那是同一段, 精确查已经
 * 命中过了。
 */
function isMaskedVariant(a, b) {
  if (a.length !== b.length) return false;
  let sawMask = false;
  for (let k = 0; k < a.length; k += 1) {
    const x = visible(a[k]);
    const y = visible(b[k]);
    // 整行被盖光就没有证据可比 —— 空串是任何字符串的前缀, 那一行会跟任何
    // 词都"相容"。实测两句全盖住的段落能同时匹配《山楂树之恋》和《你是一只
    // 飞鸟》, 而且查询没有排序, 谁先返回谁赢。宁可整段退回算法。
    if (!x || !y) return false;
    if (hasMask(a[k]) || hasMask(b[k])) sawMask = true;
    if (x === y) continue;
    if (hasMask(a[k]) && y.startsWith(x)) continue;
    if (hasMask(b[k]) && x.startsWith(y)) continue;
    return false;
  }
  return sawMask;
}

/** 乱序变体: 句子多重集合相同, 但排列不同。 */
function isShuffledVariant(a, b) {
  if (a.length !== b.length) return false;
  const av = a.map(visible);
  const bv = b.map(visible);
  const sep = '\u0001';
  if (av.slice().sort().join(sep) !== bv.slice().sort().join(sep)) return false;
  return av.join(sep) !== bv.join(sep);
}

/**
 * 这两段词是同一段的两种显示吗 —— 返回是哪一种, 不是的话返回 null。
 *
 * 调用方需要知道种类: 乱序会打乱行的次序, 而逐行答案的第 k 项说的正是
 * 「游戏第 k 行对应哪一行」, 顺序一变就全错位。首末答案没这毛病。
 */
function variantKind(a, b) {
  if (isMaskedVariant(a, b)) return 'masked';
  if (isShuffledVariant(a, b)) return 'shuffled';
  return null;
}

/** 同一段的两种显示 —— 不关心是哪一种时用这个。 */
function isVariant(a, b) {
  return variantKind(a, b) !== null;
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
    // 这段词在表里有记录 —— 记录怎么说就怎么算, 到此为止。已确认的给答案,
    // 还在队列里的(pending / ai_reviewed)和人说过「没有对应」的(unmatchable)
    // 都退回算法。下面的变体兜底只服务于表里根本没有的段落 —— 否则一段词
    // 明明在等人判断, 却能从旁边一条已确认的兄弟那里拿到答案, 把那次判断
    // 绕过去了。
    if (row) {
      if (row.status !== 'approved') return null;
      return isUsable(row.answer, lineCount) ? row.answer : null;
    }

    // 精确没命中, 再看是不是某个已确认段落的变体。
    //
    // 只在这一首录音里找, 绝不跨录音: 答案是真实歌词的行号, 换一份录音行号
    // 就全变了。实测每首歌平均只有 1.09 条已确认(最多 2 条), 所以这一步是
    // 一次小查询加几次字符串比对 —— 量到 0.94ms, 和上面那次精确查一样快,
    // 而命中之后省掉的是整首歌词的窗口滑动, 净赚。
    const mine = passageLines(gameLyric);
    const siblings = await prisma.lyricPassageMatch.findMany({
      where: { source, externalId: String(externalId), status: 'approved' },
      select: { gameLyric: true, answer: true },
    });
    for (const sib of siblings) {
      const kind = variantKind(mine, passageLines(sib.gameLyric));
      if (!kind) continue;
      // 乱序只认首末答案。逐行答案是按游戏那边的排列写的, 句子一打乱就对不
      // 上了 —— 《Raise Your Glass》那两条已确认的就是这样: 覆盖的真实行
      // 一样, 答案却是 [0,0,1,1,2] 和 [1,1,0,2,0]。宁可回去走算法。
      if (kind === 'shuffled' && !isRangeAnswer(sib.answer)) continue;
      // 变体之间共用同一个答案 —— 它指的是真实歌词的位置, 与游戏那边怎么
      // 排、盖了多少无关。仍然过一遍 isUsable: 存的答案可能是旧的逐行形式,
      // 那种要求项数等于游戏行数, 而变体的行数虽同、形状未必仍然合用。
      if (isUsable(sib.answer, lineCount)) return sib.answer;
    }
    return null;
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
async function report(source, externalId, gameLyric, reporter) {
  if (!source || !externalId || !gameLyric || !String(gameLyric).trim()) {
    return { ok: false };
  }
  const key = {
    source,
    externalId: String(externalId),
    lyricHash: hashPassage(gameLyric),
  };
  // Distinct people, not taps. The same person re-reporting (new device, a
  // cleared localStorage) is acknowledged and ignored — three here means
  // three different singers found the marks wrong. Names are snapshots for
  // the reviewer's tooltip; the id is what dedupes. Capped so a row cannot
  // grow without bound; past the cap the count keeps moving, names stop.
  const who = reporter && reporter.id
    ? { id: String(reporter.id), name: String(reporter.name || '').slice(0, 40) }
    : null;
  const listWith = (existing) => {
    const list = Array.isArray(existing) ? existing : [];
    if (!who) return { dup: false, list };
    if (list.some((r) => r && r.id === who.id)) return { dup: true, list };
    return { dup: false, list: list.length >= 50 ? list : [...list, who] };
  };
  const bumpFor = (row) => {
    const { dup, list } = listWith(row.reporters);
    if (dup) return null;
    return {
      reportCount: { increment: 1 },
      lastReportedAt: new Date(),
      reporters: list,
    };
  };
  // An approved row is silently not counted. The page already hides the
  // button when a human-checked answer is in use, but hiding is only the UI:
  // anyone talking to the endpoint directly could still inflate a counter on
  // an answer a person verified. Refusing here makes 「已确认不能被报告」
  // true rather than merely invisible. ok:true on purpose — the client needs
  // nothing done differently, and an error would just be noise to retry.
  const existing = await prisma.lyricPassageMatch.findUnique({
    where: { source_externalId_lyricHash: key },
    select: { status: true, reporters: true },
  });
  if (existing && existing.status === 'approved') return { ok: true };
  if (existing) {
    const data = bumpFor(existing);
    if (!data) return { ok: true };
    try {
      await prisma.lyricPassageMatch.update({
        where: { source_externalId_lyricHash: key }, data,
      });
    } catch (err) {
      if (err.code !== 'P2025') throw err;
    }
    return { ok: true };
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
        reporters: who ? [who] : [],
      },
    });
  } catch (err) {
    // Two singers reporting the same new passage at once: the loser of the
    // race counts on the winner's row.
    if (err.code !== 'P2002') throw err;
    const row = await prisma.lyricPassageMatch.findUnique({
      where: { source_externalId_lyricHash: key },
      select: { status: true, reporters: true },
    });
    if (row && row.status !== 'approved') {
      const data = bumpFor(row);
      if (data) {
        await prisma.lyricPassageMatch.update({
          where: { source_externalId_lyricHash: key }, data,
        }).catch(() => {});
      }
    }
  }
  return { ok: true };
}

module.exports = {
  hashPassage, isUsable, getApproved, coveredLines, placementsOf, report,
  isRangeAnswer, normaliseAnswer,
  isVariant, variantKind, passageLines,
};
