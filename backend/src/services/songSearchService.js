const prisma = require('../db/client');
const pinyinMod = require('pinyin');
const pinyinFn = pinyinMod.pinyin || pinyinMod.default || pinyinMod;
const { T2S, S2T } = require('../utils/t2s');

/**
 * Song search for people typing into a box: 添加歌曲 and the 歌曲 tab on the
 * playlists page. The whole library (~27k songs) is held in memory and
 * matched the way search engines do it:
 *   - case, full/half width, curly/straight quotes and punctuation don't matter
 *   - traditional and simplified Chinese match each other (黄霄云 / 黄霄雲)
 *   - Chinese characters match anywhere; English and pinyin match from the
 *     start of a word / syllable, so "cry" finds One Last Cry but "ai" does
 *     not match the ai inside kai
 *   - pinyin full, initials or mixed (xqge), every reading of a polyphone
 *   - several words, each must match the title or an artist (五月天 cry)
 *   - typos: 1 for words of 4+ letters, 2 for 8+, ranked after exact matches
 * Ranking: no typo, exact title, an artist's full name, then the original text before the usual
 * reading before a rare reading, then title start / title / artist, then
 * songs put in playlists more often first.
 *
 * Imports and renames run in other processes, so the index is rebuilt in the
 * background when it is older than REFRESH_MS; until then the old one serves.
 */

const REFRESH_MS = 5 * 60 * 1000;
// Building and scanning hand the event loop back every SLICE_MS, so other
// requests aren't held up behind a search.
const SLICE_MS = 5;
const yieldNow = () => new Promise((resolve) => setImmediate(resolve));
const HAN = /\p{Script=Han}/u;
const HAN_ALL = /\p{Script=Han}/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const QUOTES = /['’‘`´ʼ]/g;

// How a term matched, best first.
const DIRECT = 0;   // the characters / words themselves
const USUAL = 1;    // pinyin, usual reading
const RARE = 2;     // pinyin, any reading of a polyphone

function normalize(s) {
  return (s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFKC')
    .toLowerCase()
    .replace(QUOTES, '')
    .replace(HAN_ALL, (c) => T2S.get(c) || c);
}

/**
 * One unit per Han character or per word of other letters/digits, shared by
 * every song that has it (most of the index is the same few thousand
 * characters). d = the text, already simplified; usual / all = pinyin
 * readings (usual first, ü also as u; `all` also has the readings of its
 * traditional forms, so 谁 keeps 誰's shei); f = every first letter it can
 * start with.
 */
const unitCache = new Map();
function unit(d) {
  let u = unitCache.get(d);
  if (u) return u;
  let usual = null, all = null;
  if (HAN.test(d)) {
    const readings = (c) => (pinyinFn(c, { style: 0, heteronym: true })[0] || []).filter((x) => /^[a-z]+$/.test(x));
    const raw = [...readings(d), ...(S2T.get(d) || []).flatMap(readings)];
    const spell = (x) => (x.includes('v') ? [x, x.replace(/v/g, 'u')] : [x]);
    if (raw.length) {
      usual = spell(raw[0]);
      all = [...new Set(raw.flatMap(spell))];
    }
  }
  const f = [...new Set([d[0], ...(all || []).map((s) => s[0])])].join('');
  u = { d, usual, all, f };
  unitCache.set(d, u);
  return u;
}

/**
 * A field (a title, or one artist) as units. Punctuation and spaces only
 * separate. `flat` spells the field with usual readings (typo matching);
 * `key` is the text without separators; `f` every letter a unit starts with.
 * Fields are shared by text: one artist's hundreds of songs hold one field.
 */
const fieldCache = new Map();
function field(text) {
  let fd = fieldCache.get(text);
  if (!fd) { fd = tokenize(text); fieldCache.set(text, fd); }
  return fd;
}

function tokenize(text) {
  const units = [];
  let word = '';
  const flushWord = () => { if (word) { units.push(unit(word)); word = ''; } };
  for (const ch of normalize(text)) {
    if (HAN.test(ch)) { flushWord(); units.push(unit(ch)); }
    else if (WORD_CHAR.test(ch)) word += ch;
    else flushWord();
  }
  flushWord();
  let flat = '', key = '', f = '';
  for (const u of units) {
    flat += u.usual ? u.usual[0] : u.d;
    key += u.d;
    for (const c of u.f) if (!f.includes(c)) f += c;
  }
  return { units, flat, key, f };
}

/**
 * What typing an artist's name in full looks like: the name, its pinyin, its
 * initials -- also for the Chinese and the other part alone (G.E.M. 邓紫棋
 * answers to 邓紫棋, dengziqi, dzq and gem).
 */
function artistNames(fd) {
  if (fd.names) return fd.names;
  const han = fd.units.filter((u) => u.usual);
  const other = fd.units.filter((u) => !u.usual);
  const names = new Set();
  for (const us of [fd.units, han, other]) {
    if (!us.length) continue;
    names.add(us.map((u) => u.d).join(''));
    names.add(us.map((u) => (u.usual ? u.usual[0] : u.d)).join(''));
    names.add(us.map((u) => (u.usual ? u.usual[0][0] : u.d)).join(''));
  }
  fd.names = [...names].filter((n) => n.length >= 2); // "a" is not 阿YueYue's name
  return fd.names;
}

// (unit, position) states consume() has already failed from in this matchField
// call. Without it a title of repeated polyphones (的的的…) takes exponential time.
let failed = new Int32Array(4096);
let failRun = 0;
let failWidth = 0;

/** Can term[p..] be spelled by units i, i+1, ...? The last unit may be partial. */
function consume(units, i, term, p, how) {
  if (p === term.length) return true;
  if (i === units.length) return false;
  const key = i * failWidth + p;
  if (failed[key] === failRun) return false;
  const u = units[i];
  const rest = term.length - p;
  if (term.startsWith(u.d, p)) {
    if (consume(units, i + 1, term, p + u.d.length, how)) return true;
  } else if (rest < u.d.length && u.d.startsWith(term.slice(p))) {
    return true;
  }
  const readings = how === USUAL ? u.usual : how === RARE ? u.all : null;
  if (readings) {
    const c = term.charCodeAt(p);
    for (const s of readings) {
      if (s.charCodeAt(0) !== c) continue;
      if (term.startsWith(s, p) && consume(units, i + 1, term, p + s.length, how)) return true;
      if (rest < s.length && s.startsWith(term.slice(p))) return true;
      if (consume(units, i + 1, term, p + 1, how)) return true; // initial
      if (s[1] === 'h' && s.length > 2 && term.startsWith(s.slice(0, 2), p)
        && consume(units, i + 1, term, p + 2, how)) return true; // zh / ch / sh
    }
  }
  failed[key] = failRun;
  return false;
}

/** First unit a term matches from, or -1. */
function matchField(field, term, how) {
  const ch = term[0];
  if (!field.f.includes(ch)) return -1;
  const { units } = field;
  failWidth = term.length + 1;
  const need = units.length * failWidth;
  if (failed.length < need) { failed = new Int32Array(need); failRun = 0; }
  if (++failRun === 0x7fffffff) { failed.fill(0); failRun = 1; }
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (how === DIRECT ? u.d[0] !== ch : !u.f.includes(ch)) continue;
    if (consume(units, i, term, 0, how)) return i;
  }
  return -1;
}

// Scratch rows for prefixDistance (terms are capped at 100 characters).
const ROWS = [0, 1, 2].map(() => new Int32Array(104));

/** Edit distance (with swaps) from `a` to the closest prefix of b[from..]; > k once over k. */
function prefixDistance(a, b, from, k) {
  const m = a.length;
  const n = Math.min(b.length - from, m + k);
  let [prev2, prev, cur] = ROWS;
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const bj = b.charCodeAt(from + j - 1);
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === bj ? 0 : 1));
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(from + j - 2)
        && a.charCodeAt(i - 2) === bj && prev2[j - 2] + 1 < v) v = prev2[j - 2] + 1;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > k) return k + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  let best = k + 1;
  for (let j = 0; j <= n; j++) if (prev[j] < best) best = prev[j];
  return best;
}

/** Typo match: same first letter, from the start of a word or Han character. */
function typoField(field, term, k) {
  const { units, flat } = field;
  const c = term.charCodeAt(0);
  for (let i = 0, at = 0; i < units.length; at += (units[i].usual ? units[i].usual[0] : units[i].d).length, i++) {
    if (flat.charCodeAt(at) !== c) continue;
    if (prefixDistance(term, flat, at, k) <= k) return i;
  }
  return -1;
}

// ── Index ──────────────────────────────────────────────────────────────────

let index = null; // { songs: [{ id, title, t, a: [fields], pop }], fp, pop, builtAt }
let building = null;

// Popularity only breaks ties, so it is counted rarely: scanning every
// playlist entry takes ~0.6 s on production (count DISTINCT took 3.7 s).
const POP_REFRESH_MS = 6 * 60 * 60 * 1000;
let popCache = null; // { pop: Map(songId -> playlist entries), at }

async function popularity() {
  if (popCache && Date.now() - popCache.at < POP_REFRESH_MS) return popCache.pop;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.song_id AS id, count(*)::int AS n
       FROM playlist_clips pc JOIN clips c ON c.id = pc.clip_id
      GROUP BY c.song_id`
  );
  popCache = { pop: new Map(rows.map((r) => [r.id, r.n])), at: Date.now() };
  return popCache.pop;
}

// Changes whenever a song is added, removed or renamed. Postgres works it out
// (~30 ms), so an unchanged library isn't read and indexed again every refresh.
const FINGERPRINT_SQL = `SELECT md5(string_agg(id::text || '|' || title || '|' || coalesce(artist, ''), ',' ORDER BY id)) AS fp
  FROM songs`;

async function build() {
  const [[{ fp }], pop] = await Promise.all([prisma.$queryRawUnsafe(FINGERPRINT_SQL), popularity()]);
  if (index && index.fp === fp) {
    if (index.pop !== pop) for (const s of index.songs) s.pop = pop.get(s.id) || 0;
    return { ...index, pop, builtAt: Date.now() };
  }
  const rows = await prisma.$queryRawUnsafe('SELECT id, title, artist FROM songs');
  const songs = [];
  let sliceStart = Date.now();
  for (const r of rows) {
    if (Date.now() - sliceStart >= SLICE_MS) { await yieldNow(); sliceStart = Date.now(); }
    songs.push({
      id: r.id,
      title: r.title,
      t: field(r.title),
      a: (r.artist || '').split('_').filter(Boolean).map((name) => {
        const fd = field(name);
        artistNames(fd);
        return fd;
      }),
      pop: pop.get(r.id) || 0,
    });
  }
  fieldCache.clear(); // the songs hold what they use; the next build starts fresh
  return { songs, fp, pop, builtAt: Date.now() };
}

function rebuild() {
  if (!building) {
    building = build()
      .then((idx) => { index = idx; return idx; })
      .finally(() => { building = null; });
  }
  return building;
}

async function getIndex() {
  if (!index) return rebuild();
  if (Date.now() - index.builtAt > REFRESH_MS) rebuild().catch(() => {}); // serve the old one meanwhile
  return index;
}

// ── Search ─────────────────────────────────────────────────────────────────

/** The query's words; the 100-char cap holds after normalizing (㎉ → kcal). */
function queryWords(q) {
  return normalize(String(q || '').slice(0, 100)).slice(0, 100).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Words to match: each once, at most MAX_TERMS ("Love Love Love" is one). */
const MAX_TERMS = 10;
function queryTerms(q) {
  return [...new Set(queryWords(q))].slice(0, MAX_TERMS);
}

/**
 * How one term matches one field: { pos, how, typo } or null. Best way
 * first: direct, usual reading, any reading, then a typo.
 */
function matchOne(fd, term) {
  if (!fd.f.includes(term[0])) return null;
  const latin = /[a-z]/.test(term);
  for (const how of latin ? [DIRECT, USUAL, RARE] : [DIRECT]) {
    const pos = matchField(fd, term, how);
    if (pos >= 0) return { pos, how, typo: 0 };
  }
  if (term.length >= 4 && /^[a-z0-9]+$/.test(term)) {
    const pos = typoField(fd, term, term.length >= 8 ? 2 : 1);
    if (pos >= 0) return { pos, how: DIRECT, typo: 1 };
  }
  return null;
}

const better = (x, y) => (!y || x.typo < y.typo || (x.typo === y.typo && x.how < y.how));

/**
 * Match one term against a song: { inTitle, pos, how, typo } or null. The
 * title wins a tie with an artist. `memo` holds this query's artist results.
 */
function matchTerm(song, term, memo) {
  const t = matchOne(song.t, term);
  let a = null;
  for (const fd of song.a) {
    let m = memo.get(fd);
    if (m === undefined) { m = matchOne(fd, term); memo.set(fd, m); }
    if (m && better(m, a)) a = m;
  }
  if (t && !better(a || { typo: 2 }, t)) return { inTitle: true, pos: t.pos, how: t.how, typo: t.typo };
  return a && { inTitle: false, pos: -1, how: a.how, typo: a.typo };
}

/**
 * Ranked song ids for a query, `limit` of them from `offset`: { ids, total }.
 * Sort key: typo, exact title (as typed or in pinyin), an artist's full name
 * (as typed, pinyin or initials), how (direct / usual / rare reading), tier
 * (2 title start, 3 title, 4 artist), times in playlists (desc), title
 * length, title, id (so pages don't shift between requests).
 */
async function search(q, limit = 50, offset = 0) {
  const terms = queryTerms(q);
  if (!terms.length) return { ids: [], total: 0 };
  const { songs } = await getIndex();
  const whole = queryWords(q).join(''); // as typed, for the exact-title / artist-name checks
  const memos = terms.map(() => new Map());
  const hits = [];
  let sliceStart = Date.now();
  for (let s = 0; s < songs.length; s++) {
    if ((s & 63) === 0 && Date.now() - sliceStart >= SLICE_MS) { await yieldNow(); sliceStart = Date.now(); }
    const song = songs[s];
    let typo = 0, how = DIRECT, allTitle = true, firstPos = -1;
    let ok = true;
    for (let n = 0; n < terms.length; n++) {
      const m = matchTerm(song, terms[n], memos[n]);
      if (!m) { ok = false; break; }
      if (m.typo) typo = 1;
      if (m.how > how) how = m.how;
      if (!m.inTitle) allTitle = false;
      if (n === 0) firstPos = m.pos;
    }
    if (!ok) continue;
    const exact = !typo && (whole === song.t.key || whole === song.t.flat);
    const artist = !exact && !typo && song.a.some((fd) => fd.names.includes(whole));
    const tier = exact ? 0 : artist ? 1 : allTitle && firstPos === 0 ? 2 : allTitle ? 3 : 4;
    hits.push({ song, typo, how, tier });
  }
  hits.sort((x, y) => x.typo - y.typo || Math.min(x.tier, 2) - Math.min(y.tier, 2) || x.how - y.how || x.tier - y.tier
    || y.song.pop - x.song.pop || x.song.title.length - y.song.title.length
    || (x.song.title < y.song.title ? -1 : x.song.title > y.song.title ? 1 : 0)
    || (x.song.id < y.song.id ? -1 : x.song.id > y.song.id ? 1 : 0));
  return { ids: hits.slice(offset, offset + limit).map((h) => h.song.id), total: hits.length };
}

module.exports = { search, rebuild, normalize, queryTerms };
