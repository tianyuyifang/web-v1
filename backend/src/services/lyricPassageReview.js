/**
 * The review side of verified lyric passages.
 *
 * A reviewer needs three things on screen to judge one of these: the passage as
 * the game showed it, the answer being proposed, and the real lyrics to check
 * it against. All three come back together — the alternative is three requests
 * per row, and the queue is meant to be worked through quickly.
 *
 * Reads are editor-only, like the rest of the review page: an answer here
 * decides what every singer sees highlighted, so it is the same kind of
 * site-wide decision a mapping is.
 */
const prisma = require('../db/client');
const { AppError, NotFoundError } = require('../utils/errors');
const lyricStore = require('./lyricStore');
const { hashPassage, isUsable, coveredLines } = require('./lyricPassageStore');
const { markPassage } = require('../../../frontend/src/lib/passageMatch');

const STATUSES = new Set(['approved', 'pending', 'unmatchable', 'ai_reviewed']);

/** The game's own split, matching LiveLyrics.js exactly. */
function splitGameLines(gameLyric) {
  return String(gameLyric == null ? '' : gameLyric)
    .split(/[\n/]+/).map((l) => l.trim()).filter(Boolean);
}

/** Real lyric lines, timing tags stripped, as the page sees them. */
function splitReal(lyric) {
  return String(lyric == null ? '' : lyric)
    .split('\n').map((l) => l.replace(/^\[[^\]]*\]/, '').trim()).filter(Boolean);
}

/**
 * One page of the queue, newest first.
 *
 * The real lyrics are fetched from the store only — never from the platform.
 * Review is a browsing activity and a reviewer may open dozens of rows; going
 * to QQ for each would be the burst pattern the lyric store exists to prevent.
 * A row whose words are not stored yet simply shows none.
 */
/**
 * 游戏画面的歌名/歌手, 批量取。
 *
 * 段落表只存 (source, externalId), 歌名歌手在 song_mappings 的 rawTitle/
 * rawArtist(QNI 游戏画面的写法)。一首录音可能多条映射, 取 approved
 * 的那条; 都未确认就取任意一条。keys: ['QQ 123', ...]。
 */
async function gameNamesFor(keys) {
  const out = new Map();
  const pairs = [...new Set(keys)].map((k) => {
    const sp = k.indexOf(' ');
    return { source: k.slice(0, sp), externalId: k.slice(sp + 1) };
  });
  if (!pairs.length) return out;
  const rows = await prisma.songMapping.findMany({
    where: { OR: pairs.map((p) => ({ source: p.source, externalId: p.externalId })) },
    select: { source: true, externalId: true, rawTitle: true, rawArtist: true, approved: true },
    orderBy: { approved: 'desc' },
  });
  for (const r of rows) {
    const k = `${r.source} ${r.externalId}`;
    if (!out.has(k)) out.set(k, { gameTitle: r.rawTitle, gameArtist: r.rawArtist });
  }
  return out;
}

async function list({ status = 'pending', take = 30, cursor, reportedOnly = false } = {}) {
  if (!STATUSES.has(status)) status = 'pending';
  const rows = await prisma.lyricPassageMatch.findMany({
    // reportedOnly: the approved tab's 「只看被报告的」 filter.
    where: { status, ...(reportedOnly ? { reportCount: { gt: 0 } } : {}) },
    // Most-reported first: a report is a singer saying the marks were wrong,
    // so the queue leads with the passages hurting the most people.
    orderBy: [{ reportCount: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    take: Math.min(Number(take) || 30, 100),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  // One read per distinct recording rather than per row: a song usually has
  // several passages waiting, and they share the same words.
  const wanted = [...new Set(rows.map((r) => `${r.source} ${r.externalId}`))];
  const lyrics = new Map();
  await Promise.all(wanted.map(async (k) => {
    const [source, externalId] = k.split(' ');
    if (source === 'LOCAL') {
      const song = await prisma.song.findUnique({
        where: { id: externalId }, select: { lyrics: true },
      }).catch(() => null);
      lyrics.set(k, splitReal(song && song.lyrics));
      return;
    }
    const track = await prisma.importedTrack.findUnique({
      where: { source_externalId: { source, externalId } }, select: { lyric: true },
    }).catch(() => null);
    lyrics.set(k, splitReal(track && track.lyric));
  }));

  const names = await gameNamesFor(wanted);

  return {
    items: rows.map((r) => ({
      id: r.id,
      source: r.source,
      externalId: r.externalId,
      gameTitle: names.get(`${r.source} ${r.externalId}`)?.gameTitle || null,
      gameArtist: names.get(`${r.source} ${r.externalId}`)?.gameArtist || null,
      gameLines: splitGameLines(r.gameLyric),
      answer: r.answer,
      status: r.status,
      verifiedBy: r.verifiedBy,
      note: r.note,
      reportCount: r.reportCount,
      lastReportedAt: r.lastReportedAt,
      reporters: Array.isArray(r.reporters) ? r.reporters : [],
      updatedAt: r.updatedAt,
      realLines: lyrics.get(`${r.source} ${r.externalId}`) || [],
      // 算法对这段现场算一次的猜测(拍平的行号), 供审核看算法错在哪。
      // 只读展示, 不入库。
      algoGuess: (() => {
        const real = lyrics.get(`${r.source} ${r.externalId}`) || [];
        if (!real.length) return [];
        try {
          const places = markPassage(r.gameLyric, real.map((t) => ({ text: t })));
          return places.map((pl) => [...new Set(pl.filter((i) => i >= 0))].sort((a, b) => a - b));
        } catch (e) { return []; }
      })(),
    })),
    nextCursor: rows.length ? rows[rows.length - 1].id : null,
  };
}

/** How many are waiting, per status. Drives the tab badge. */
async function counts() {
  const rows = await prisma.lyricPassageMatch.groupBy({
    by: ['status'], _count: { _all: true },
  });
  const out = { approved: 0, pending: 0, unmatchable: 0, ai_reviewed: 0 };
  rows.forEach((r) => { out[r.status] = r._count._all; });
  // Approved rows singers are still reporting: the ⚠ on the tab label. Worth
  // its own count — they are invisible inside a large approved list otherwise.
  out.reportedApproved = await prisma.lyricPassageMatch.count({
    where: { status: 'approved', reportCount: { gt: 0 } },
  });
  return out;
}

/**
 * A reviewer's decision.
 *
 * Their answer is stored as `human`, which outranks the assistant's and is
 * never overwritten by a later pass — correcting a mistake has to stick.
 *
 * The answer is re-checked against the passage rather than trusted, for the
 * same reason the importer checks it: an answer one line short misaligns
 * everything after it, and the page would show that with full confidence.
 */
async function decide(id, { status, answer, note } = {}) {
  if (!STATUSES.has(status)) {
    throw new AppError('status must be approved, pending or unmatchable', 400);
  }
  const row = await prisma.lyricPassageMatch.findUnique({ where: { id } });
  if (!row) {
    throw new NotFoundError('Passage');
  }

  const lines = splitGameLines(row.gameLyric).length;
  let next = row.answer;
  if (answer !== undefined) {
    if (!isUsable(answer, lines)) {
      throw new AppError(`答案要有 ${lines} 个数字（每个游戏行一个），用逗号分隔`, 400);
    }
    next = answer;
  }
  if (status === 'unmatchable' && Array.isArray(next) && coveredLines(next).length) {
    // Saying "there is no counterpart" and pointing at one at the same time
    // would leave a row that means nothing. Blank it instead of refusing.
    next = new Array(lines).fill(-1);
  }
  if ((status === 'approved' || status === 'ai_reviewed')
    && (!Array.isArray(next) || !coveredLines(next).length)) {
    throw new AppError('an approved answer must place at least one line', 400);
  }

  // A decision that changes anything clears the reports: the badge marks
  // 「唱的人说不准、还没人处理」, and this is the processing. A save that
  // changes nothing keeps the count — the complaint stands until something
  // is actually done about it.
  const changed = (answer !== undefined) || status !== row.status;
  return prisma.lyricPassageMatch.update({
    where: { id },
    data: {
      status,
      answer: next,
      verifiedBy: 'human',
      ...(note !== undefined ? { note: note || null } : {}),
      // The roster goes with the count. Leaving it would make the per-person
      // dedup treat a re-report of the CHANGED answer as a duplicate of the
      // old complaint — silently ignored, count stuck at 0, invisible forever.
      ...(changed ? { reportCount: 0, lastReportedAt: null, reporters: [] } : {}),
    },
  });
}

/**
 * 唱卡集 —— 浏览所有遇到过的段落, 与审核无关。
 *
 * 数据源是 capture_events(演唱阶段、有歌词的), 而不是段落表
 * —— 后者只有被报告/导入过的少数。按(游戏原文)去重, 同一段
 * 词不管被唱多少次只算一行; 带游戏名/歌手(同一首歌的多个段
 * 落共用一个名字)、出现次数; 可按游戏名/歌手搜。
 *
 * 只读, raw SQL: 先按歌(source+externalId, 辇自 song_mappings 的 clip→mapping
 * 链辇不存在, 所以改用 raw_text 与 mapping 的游戏名匹配)…——实际上
 * capture_events 没存 source/externalId, 只有 raw_text(游戏原文「歌名-歌手」)。
 * 所以唱卡集直接以 raw_text 为歌的身份, 按 (raw_text, lyric) 去重, 搜索
 * 就在 raw_text 上进行。
 */
/**
 * 把流水账里还没数过的唱卡事件累加进唱卡集。
 *
 * 只在有人打开唱卡集时跑, 抓取路径一行都不碰 —— 唱卡集是锦上添花, 而抓取是
 * 游戏进行中的实时路径, 不值得为一张统计表在那条路上多做事。
 *
 * 增量的依据是 passage_catalogue_sync 记的时刻: 只取比它新的事件, 否则每次
 * 打开都会把整张流水重数一遍, 已经数过的被重复累加。首次没有这一行, 就把
 * 现存的全部数进来(实测 9512 行 / 318ms), 那就是起点。
 *
 * 漏数的可能: 两次同步之间被 prune-captures 删掉的事件(默认 30 天)。接受这个
 * 代价, 因为同一段词会反复唱到, 漏掉的下次自己回来 —— 真正丢的只有「这一个月
 * 唱过、以后再没唱过」的段落, 而那种段落本来也不值得留。
 *
 * ON CONFLICT 累加而不是覆盖: 同一段词这次又唱了几回, seen 就往上加几回。
 */
async function syncCatalogue() {
  /**
   * One sync at a time, across every process.
   *
   * Two admins opening the tab together would otherwise both read "never
   * synced", both count the whole log, and both add it — measured: 28314
   * events became 56628. The read of the watermark and the write of it are
   * separate statements, so the row itself cannot be the lock.
   *
   * pg_advisory_lock is a lock on a number, not on any table: it serialises
   * this function and touches nothing else, so captures keep being written
   * while it is held. The second admin waits out the first sync (~5ms once
   * warm) and then finds the watermark already moved, so there is nothing
   * left to count. Released in the finally below — a session-level advisory
   * lock outlives the transaction and would otherwise leak on the first
   * error and block every later sync.
   */
  const LOCK_KEY = 8123401; // arbitrary, unique to this job
  await prisma.$executeRawUnsafe('SELECT pg_advisory_lock($1)', LOCK_KEY);
  try {
    await syncCatalogueLocked();
  } finally {
    await prisma.$executeRawUnsafe('SELECT pg_advisory_unlock($1)', LOCK_KEY)
      .catch(() => {});
  }
}

async function syncCatalogueLocked() {
  const mark = await prisma.passageCatalogueSync.findUnique({ where: { id: 'singleton' } });
  const since = mark?.syncedAt || null;
  // 现在时刻先取下来, 拿它当这次的水位。用 now() 会把同步期间新到的事件也算进
  // 水位里, 而它们未必进了这次的 GROUP BY, 下次就再也数不到了。
  const now = new Date();

  const conds = [
    "stage = 'singing'",
    'lyric IS NOT NULL',
    "lyric <> ''",
    'raw_text IS NOT NULL',
    'created_at <= $1',
  ];
  const params = [now];
  if (since) {
    params.push(since);
    conds.push(`created_at > $${params.length}`);
  }

  await prisma.$executeRawUnsafe(`
    INSERT INTO passage_catalogue (id, raw_text, lyric, seen, first_seen, last_seen)
    SELECT gen_random_uuid(), raw_text, lyric, COUNT(*)::int,
           MIN(created_at), MAX(created_at)
    FROM capture_events
    WHERE ${conds.join(' AND ')}
    GROUP BY raw_text, lyric
    ON CONFLICT (raw_text, lyric) DO UPDATE
      SET seen = passage_catalogue.seen + EXCLUDED.seen,
          first_seen = LEAST(passage_catalogue.first_seen, EXCLUDED.first_seen),
          last_seen = GREATEST(passage_catalogue.last_seen, EXCLUDED.last_seen)
  `, ...params);

  await prisma.passageCatalogueSync.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', syncedAt: now },
    update: { syncedAt: now },
  });
}

/**
 * 唱卡集 —— 浏览所有遇到过的段落, 与审核无关。
 *
 * 读 passage_catalogue, 不再现场聚合 capture_events。两点不同:
 *
 *   次数是历史累计, 不再是「30 天内」。以前现场 COUNT(*) 数流水, 数到的只有
 *   还没被清理删掉的那些, 于是一首歌不唱了, 次数会一路掉到 0, 整首从唱卡集
 *   消失 —— 而这里恰恰是唯一能回头看「都遇到过什么」的地方。
 *
 *   快得多。实测 GROUP BY 28311 行要 71ms 且随数据增长, 读这张小表 4ms。
 *
 * 收录范围没变: 演唱阶段、有歌词、有歌名, 与是否已确认无关 —— 唱卡集要的是
 * 游戏里出现过的全部段落, 段落表里只有被报告或导入过的那少数。
 */
async function catalogue({ q = '', offset = 0, take = 40 } = {}) {
  const limit = Math.min(Number(take) || 40, 100);
  const skip = Math.max(0, Number(offset) || 0);

  // 先补上这次没数过的, 再读。失败就让它抛 —— 打开唱卡集时当场看见, 比悄悄
  // 少算一截好; 下次打开自动重试, 因为水位没推进。
  await syncCatalogue();

  const where = {};
  const query = String(q || '').trim();
  if (query) where.rawText = { contains: query, mode: 'insensitive' };

  const rows = await prisma.passageCatalogue.findMany({
    where,
    select: { rawText: true, lyric: true, seen: true },
    orderBy: [{ seen: 'desc' }, { lastSeen: 'desc' }],
    skip,
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    items: page.map((r) => {
      // raw_text 格式「歌名-歌手」—— 拆最后一个连字符。拆不开就整个当歌名。
      const raw = String(r.rawText);
      const dash = raw.lastIndexOf('-');
      const gameTitle = dash > 0 ? raw.slice(0, dash) : raw;
      const gameArtist = dash > 0 ? raw.slice(dash + 1) : '';
      return {
        rawText: raw,
        gameTitle,
        gameArtist,
        gameLines: splitGameLines(r.lyric),
        lyricHash: hashPassage(r.lyric),
        seen: r.seen,
      };
    }),
    nextOffset: hasMore ? skip + limit : null,
  };
}

/**
 * 删掉一条段落记录 —— 换音源后产生的孤儿待确认, 或不该存在的报告。
 * 只删 lyric_passage_matches 这一行, 不碰任何别的表。删掉 = 该段回退走算法。
 */
async function remove(id) {
  const row = await prisma.lyricPassageMatch.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Passage');
  await prisma.lyricPassageMatch.delete({ where: { id } });
  return { ok: true };
}

module.exports = { list, counts, decide, remove, catalogue, syncCatalogue, splitGameLines, splitReal, hashPassage };
