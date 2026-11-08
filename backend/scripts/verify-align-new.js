/*
 * Why this exists (reference_update_playlists step 5):
 * a newly imported row has wordLyric written but `lyric` filled in later.
 * The frontend highlights word-by-word by MATCHING wordLyric text against the
 * line-lyric lines, so the two must actually line up. Pure DB read, no outbound.
 *
 * HOURS env var picks the window of "new" rows (default 48).
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

const HOURS = parseInt(process.env.HOURS || '48', 10);

// Build the punctuation class from char codes so no shell/heredoc can eat an escape.
const PUNCT = new Set(
  [',', '，', '.', '。', '!', '！', '?', '？', '~', '、',
    '…', '-', '–', '—', '"', "'", '“', '”', '‘',
    '’', '(', ')', '（', '）', '[', ']', '【', '】',
    ':', '：', ';', '；', '/', '\\', '《', '》', '*', '·']
);

function norm(s) {
  let out = '';
  for (const ch of String(s || '')) {
    if (/\s/.test(ch)) continue;
    if (PUNCT.has(ch)) continue;
    out += ch.toLowerCase();
  }
  return out;
}

function lineTexts(lrc) {
  if (!lrc) return [];
  const out = [];
  for (const raw of String(lrc).split(/\r?\n/)) {
    // strip every leading [..] tag (timestamps and metadata alike)
    let s = raw;
    let m;
    while ((m = s.match(/^\s*\[[^\]]*\]/))) s = s.slice(m[0].length);
    const t = norm(s);
    if (t) out.push(t);
  }
  return out;
}

function wordTexts(wl) {
  if (!wl) return [];
  let obj = wl;
  if (typeof wl === 'string') {
    try { obj = JSON.parse(wl); } catch { return []; }
  }
  const lines = obj && (obj.lines || obj.l || (Array.isArray(obj) ? obj : null));
  if (!Array.isArray(lines)) return [];
  const out = [];
  for (const ln of lines) {
    let t = '';
    if (typeof ln === 'string') t = ln;
    else if (ln && typeof ln.text === 'string') t = ln.text;
    else if (ln && Array.isArray(ln.words)) t = ln.words.map((w) => (w && (w.w || w.text)) || '').join('');
    else if (ln && Array.isArray(ln.chars)) t = ln.chars.map((w) => (w && (w.c || w.text)) || '').join('');
    const n = norm(t);
    if (n) out.push(n);
  }
  return out;
}

(async () => {
  const since = new Date(Date.now() - HOURS * 3600 * 1000);
  const rows = await prisma.importedTrack.findMany({
    where: { createdAt: { gte: since } },
    select: {
      source: true, externalId: true, title: true, artist: true,
      lyric: true, wordLyric: true,
    },
  });
  console.log('new in last ' + HOURS + 'h: ' + rows.length + ' rows\n');

  let totMatch = 0;
  let totWords = 0;
  const noWord = [];
  const noLine = [];
  const low = [];
  for (const r of rows) {
    const W = wordTexts(r.wordLyric);
    const Larr = lineTexts(r.lyric);
    const L = new Set(Larr);
    if (!W.length) { noWord.push(r); continue; }
    if (!Larr.length) { noLine.push(r); continue; }
    let hit = 0;
    for (const w of W) if (L.has(w)) hit++;
    totMatch += hit;
    totWords += W.length;
    const pct = (hit / W.length) * 100;
    if (pct < 90) low.push({ r: r, pct: pct, hit: hit, n: W.length });
  }

  console.log('aligned: ' + totMatch + '/' + totWords
    + (totWords ? ' = ' + ((totMatch / totWords) * 100).toFixed(1) + '%' : ''));

  console.log('\nno word lyric (' + noWord.length + '):');
  for (const r of noWord) console.log('   ', r.title, '-', r.artist, '(' + r.source + ')');

  console.log('\nno line lyric yet (' + noLine.length + '):');
  for (const r of noLine) console.log('   ', r.title, '-', r.artist, '(' + r.source + ')');

  console.log('\nbelow 90% (' + low.length + '):');
  for (const x of low) {
    console.log('   ', x.r.title, '-', x.r.artist,
      x.pct.toFixed(0) + '% (' + x.hit + '/' + x.n + ')');
  }
  await prisma.$disconnect();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
