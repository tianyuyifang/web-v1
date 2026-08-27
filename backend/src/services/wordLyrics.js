/**
 * Word-level lyrics: a time on every syllable, so a highlight can follow the
 * singing instead of sliding evenly across the line.
 *
 * Two sources, two syntaxes for the same information. QQ sends QRC, where the
 * timing follows the text: `谁(32949,209)来(33158,232)`. NetEase sends YRC,
 * where it precedes it: `(370,270,0)想(640,290,0)要`. Both are absolute
 * milliseconds. Neither shape is worth putting in front of the player, which
 * cares only about when each syllable starts, so both are normalised here.
 *
 * Fetched once and stored, like the line-level lyrics beside them. Both
 * endpoints answer anonymously — no cookie, no account — which is checked at
 * the call site rather than assumed: a lyric request that carried credentials
 * would spend a user's account on something that does not need one.
 */
const https = require('https');
const zlib = require('zlib');
const { tripleDesDecrypt } = require('./sources/qrcDes');

/** Published in several open-source players; obfuscation, not a secret. */
const QRC_KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'latin1');

/**
 * Smallest gap between two calls to a platform from this module.
 *
 * The backfill walks the whole catalogue, so this is the difference between a
 * slow crawl and a burst that looks like scraping. Deliberately slower than
 * the playback path's 200 ms: nothing is waiting on these.
 */
const MIN_GAP_MS = 800;
const lastCallAt = new Map();

async function pace(platform) {
  const now = Date.now();
  const prev = lastCallAt.get(platform) || 0;
  const slot = Math.max(now, prev + MIN_GAP_MS);
  lastCallAt.set(platform, slot);
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function requestJson({ host, path, method = 'GET', body, referer }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { 'User-Agent': UA, Referer: referer };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    // No Cookie header, ever. These endpoints answer anonymously and a
    // credential here would be spent for nothing.
    const req = https.request({ host, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.httpStatus = res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('unparseable response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

// --- parsing ---------------------------------------------------------------

/**
 * One line: when it starts, how long it runs, and each syllable within it.
 *
 * `syllables` carry a start and an end rather than a duration, because the
 * player asks "where am I in this line" and subtracting on every frame is
 * work it does not need to repeat.
 */
function makeLine(start, duration, syllables, text) {
  return { start, end: start + duration, text, syllables };
}

/** QQ: `[lineStart,lineDur]text(start,dur)text(start,dur)…` */
const QRC_LINE = /^\[(\d+),(\d+)\](.*)$/;
const QRC_TOKEN = /([^(]*)\((\d+),(\d+)\)/g;

function parseQrc(xml) {
  // The payload is XML wrapping an LRC-like body in an attribute. Pulling the
  // attribute out with a regex rather than an XML parser: the body contains
  // unescaped brackets and parentheses, and every parser worth using rejects
  // it. The delimiters here are unambiguous.
  const m = xml.match(/LyricContent="([\s\S]*?)"\s*\/?>/);
  const body = m ? m[1] : xml;

  const lines = [];
  for (const raw of body.split(/\r?\n/)) {
    const lm = raw.match(QRC_LINE);
    if (!lm) continue;
    const start = Number(lm[1]);
    const duration = Number(lm[2]);
    const rest = lm[3];

    const syllables = [];
    let text = '';
    QRC_TOKEN.lastIndex = 0;
    let tm;
    while ((tm = QRC_TOKEN.exec(rest)) !== null) {
      const word = tm[1];
      const at = Number(tm[2]);
      const dur = Number(tm[3]);
      if (!word) continue;
      syllables.push({ t: at, e: at + dur, w: word });
      text += word;
    }
    if (syllables.length) lines.push(makeLine(start, duration, syllables, text));
  }
  return lines;
}

/** NetEase: `[lineStart,lineDur](start,dur,0)text(start,dur,0)text…` */
const YRC_LINE = /^\[(\d+),(\d+)\](.*)$/;
const YRC_TOKEN = /\((\d+),(\d+),\d+\)([^(]*)/g;

function parseYrc(text) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    // The first lines are JSON metadata — credits and artist links — not
    // timed text. They fail this shape, which is the filter.
    const lm = raw.match(YRC_LINE);
    if (!lm) continue;
    const start = Number(lm[1]);
    const duration = Number(lm[2]);
    const rest = lm[3];

    const syllables = [];
    let joined = '';
    YRC_TOKEN.lastIndex = 0;
    let tm;
    while ((tm = YRC_TOKEN.exec(rest)) !== null) {
      const at = Number(tm[1]);
      const dur = Number(tm[2]);
      const word = tm[3];
      if (!word) continue;
      syllables.push({ t: at, e: at + dur, w: word });
      joined += word;
    }
    if (syllables.length) lines.push(makeLine(start, duration, syllables, joined));
  }
  return lines;
}

/**
 * Is this worth storing?
 *
 * A payload can decrypt and parse and still be useless: the credits header
 * alone parses, and some tracks return a handful of lines that are all
 * metadata. Requiring several lines and some actual syllables keeps those out
 * of the column, so "has word lyrics" means what it says.
 */
function looksSung(lines) {
  if (!Array.isArray(lines) || lines.length < 4) return false;
  const syllables = lines.reduce((n, l) => n + l.syllables.length, 0);
  return syllables >= 12;
}

// --- fetching --------------------------------------------------------------

const b64 = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');

/**
 * QQ, via the player's own lyric call.
 *
 * `songName`/`singerName` are base64 and are not decoration: the endpoint
 * returns nothing useful without plausible metadata alongside the mid.
 */
async function fetchQq({ externalId, title, artist, durationSec }) {
  await pace('QQ');
  const json = await requestJson({
    host: 'u.y.qq.com',
    path: '/cgi-bin/musicu.fcg',
    method: 'POST',
    referer: 'https://y.qq.com/',
    body: {
      comm: { ct: '19', cv: '1859' },
      request: {
        method: 'GetPlayLyricInfo',
        module: 'music.musichallSong.PlayLyricInfo',
        param: {
          songMID: externalId,
          songName: b64(title),
          singerName: b64(artist),
          albumName: b64(''),
          interval: durationSec || 0,
          crypt: 1, qrc: 1, roma: 0, trans: 0, ct: 19, cv: 2111,
        },
      },
    },
  });

  const data = json?.request?.data;
  // "0" is how the endpoint says it has none, rather than omitting the field.
  if (!data || !data.lyric || String(data.qrc_t) === '0') return null;

  const decrypted = zlib.inflateSync(
    tripleDesDecrypt(Buffer.from(data.lyric, 'hex'), QRC_KEY)
  ).toString('utf8');
  const lines = parseQrc(decrypted);
  return looksSung(lines) ? lines : null;
}

/**
 * NetEase, via the versioned lyric call.
 *
 * The older endpoint this project already used returns no `yrc` at all even
 * when asked with kv:-1 — measured on tracks that do have word timings here.
 * The version in the path is the whole difference.
 */
async function fetchNetease({ externalId }) {
  await pace('NETEASE');
  const json = await requestJson({
    host: 'music.163.com',
    path: `/api/song/lyric/v1?id=${encodeURIComponent(externalId)}`
      + '&cp=false&tv=0&lv=0&rv=0&kv=0&yv=0&ytv=0&yrv=0',
    referer: 'https://music.163.com/',
  });
  const yrc = json?.yrc?.lyric;
  if (!yrc) return null;
  const lines = parseYrc(yrc);
  return looksSung(lines) ? lines : null;
}

/**
 * Word-level lyrics for one track, or null when the platform has none.
 *
 * Null is an answer, not a failure: most NetEase tracks genuinely have none,
 * and the caller records that it asked so the same song is not asked again.
 * A thrown error means the request itself failed and is worth retrying.
 */
async function fetch(track) {
  if (track.source === 'QQ') return fetchQq(track);
  if (track.source === 'NETEASE') return fetchNetease(track);
  // LOCAL songs come from our own files and have only what was imported with
  // them; there is no platform to ask.
  return null;
}

module.exports = { fetch, parseQrc, parseYrc, looksSung, MIN_GAP_MS };
