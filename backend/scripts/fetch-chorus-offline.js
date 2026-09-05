/**
 * 离线拉副歌点 —— 在自己电脑上跑, 服务器一次外呼都不发。
 *
 * 读 need-chorus.json(从 VM 导出的待办清单), 逐首问平台, 结果写进
 * chorus-results.json。不连数据库: 拿到的东西回头生成 SQL 传上去入库。
 *
 * 断点续跑靠结果文件本身 —— 问过的(哪怕平台说没有)就不再问, 所以中途
 * Ctrl+C、断网、cookie 过期重来, 都只补没问过的那些。
 *
 * 节奏刻意放得很慢, 因为这趟活的风险不在时间而在账号:
 *   - QQ 每首一次带 cookie 的搜索, 默认 1.5 秒一首, 还带 ±40% 抖动 ——
 *     固定间隔本身就是机器指纹, 匀速请求比慢请求更显眼。每 200 首歇 30 秒。
 *   - 网易云不带凭证, 一次问 200 首, 批间 3 秒。烧的是家里宽带, 不是服务器。
 * 6869 首 QQ 按这个节奏约 3 小时。一次性的活, 慢比快值。
 *
 * 用法:  node fetch-chorus-offline.js              全跑(可反复运行续跑)
 *        node fetch-chorus-offline.js --dir /path/to/data   指定数据目录
 *        node fetch-chorus-offline.js --limit 50   先跑 50 首看看
 *        node fetch-chorus-offline.js --pace 2500  更慢
 *        node fetch-chorus-offline.js --source NETEASE
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

/**
 * 数据文件默认在当前工作目录, 不在脚本旁边 —— 这三个文件是一次性的中间产物
 * (待办清单、结果、cookie), 不该躺在 repo 里跟着 git 走, 尤其 cookie。
 * 用 --dir 指到别处, 或用环境变量单独指 cookie。
 */
const argvEarly = process.argv.slice(2);
const dirFlag = argvEarly.indexOf('--dir');
const DATA_DIR = dirFlag >= 0 && argvEarly[dirFlag + 1] ? argvEarly[dirFlag + 1] : process.cwd();
const LIST_FILE = path.join(DATA_DIR, 'need-chorus.json');
const OUT_FILE = path.join(DATA_DIR, 'chorus-results.json');
const COOKIE_FILE = process.env.QQ_COOKIE_FILE || path.join(DATA_DIR, 'qq_cookie.txt');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const LIMIT = Number(flag('--limit', 0)) || 0;
const ONLY = flag('--source', null);
const QQ_PACE_MS = Number(flag('--pace', 1500));
const QQ_REST_EVERY = 200;
const QQ_REST_MS = 30000;
const NE_BATCH = 200;
const NE_PACE_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 匀速请求本身就是指纹, 所以每次等待都抖一下。 */
const jitter = (ms) => Math.round(ms * (0.6 + Math.random() * 0.8));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ 结果 --- */

/** key: "SOURCE:externalId" -> { ms|null, at, note } */
let results = {};
if (fs.existsSync(OUT_FILE)) {
  try {
    results = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    console.log('续跑: 已有 ' + Object.keys(results).length + ' 首的结果。');
  } catch {
    console.log('结果文件读不动, 从头开始。');
  }
}
const keyOf = (t) => t.source + ':' + t.external_id;
let dirty = 0;
function record(track, ms, note) {
  results[keyOf(track)] = { ms: ms ?? null, at: new Date().toISOString(), note: note || null };
  dirty += 1;
  if (dirty >= 20) flush();
}
function flush() {
  if (!dirty) return;
  fs.writeFileSync(OUT_FILE, JSON.stringify(results), 'utf8');
  dirty = 0;
}

/* ---------------------------------------------------------------- 网易云 --- */

function neteaseChorus(ids) {
  const q = encodeURIComponent(JSON.stringify(ids.map(Number)));
  return new Promise((resolve, reject) => {
    const req = https.get('https://music.163.com/api/song/chorus?ids=' + q, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('返回不是 JSON: ' + e.message)); }
      });
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('超时')); });
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------------- QQ --- */

function loadCookie() {
  if (!fs.existsSync(COOKIE_FILE)) return null;
  const text = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  if (text && !text.includes('\n')) return text;
  const pairs = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.split('\t');
    if (p.length >= 7) pairs.push(p[5] + '=' + p[6]);
    else if (p.length >= 2 && p[0] && p[1]) pairs.push(p[0] + '=' + p[1]);
  }
  return pairs.length ? pairs.join('; ') : null;
}

function qqSearch(keyword, cookie) {
  const body = Buffer.from(JSON.stringify({
    comm: { ct: 24, cv: 0 },
    req_1: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { num_per_page: 20, page_num: 1, query: String(keyword), search_type: 0 },
    },
  }), 'utf8');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'u.y.qq.com', path: '/cgi-bin/musicu.fcg', method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: 'https://y.qq.com/',
        Origin: 'https://y.qq.com',
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        Cookie: cookie,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('返回不是 JSON: ' + e.message)); }
      });
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('超时')); });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * 搜「歌名 歌手」, 在结果里认 mid, 取 file.try_begin。
 *
 * 认 mid 而不是认歌名: mid 是版本级唯一的, 同名的现场版/翻唱是另一个 mid,
 * 副歌点也在别处。认不到就留空, 宁可没绿点也不安错点。
 */
async function qqChorus(track, cookie) {
  const kw = [track.title, track.artist].filter(Boolean).join(' ');
  const json = await qqSearch(kw, cookie);
  if (json?.req_1?.code === 2001) { const e = new Error('cookie 过期(code 2001)'); e.fatal = true; throw e; }
  const list = json?.req_1?.data?.body?.song?.list || [];
  const hit = list.find((s) => String(s.mid) === String(track.external_id));
  if (!hit) return { ms: null, note: 'mid 不在搜索结果里' };
  const b = Number(hit?.file?.try_begin || 0);
  return { ms: b > 0 ? b : null, note: b > 0 ? null : '平台没给试听片段' };
}

/* ------------------------------------------------------------------ 主流程 --- */

(async () => {
  const all = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  let todo = all.filter((t) => !results[keyOf(t)]);
  if (ONLY) todo = todo.filter((t) => t.source === ONLY);
  if (LIMIT) todo = todo.slice(0, LIMIT);

  const qq = todo.filter((t) => t.source === 'QQ');
  const ne = todo.filter((t) => t.source === 'NETEASE');
  console.log('待办 ' + todo.length + ' 首 (QQ ' + qq.length + ' / 网易云 ' + ne.length + ')');
  if (qq.length) {
    const mins = Math.round((qq.length * QQ_PACE_MS + Math.floor(qq.length / QQ_REST_EVERY) * QQ_REST_MS) / 60000);
    console.log('QQ 预计约 ' + mins + ' 分钟(含歇脚)。');
  }

  let got = 0; let none = 0; let failed = 0;

  // ---- 网易云 ----
  for (let i = 0; i < ne.length; i += NE_BATCH) {
    const slice = ne.slice(i, i + NE_BATCH);
    try {
      const json = await neteaseChorus(slice.map((t) => t.external_id));
      const by = new Map();
      for (const c of json?.chorus || []) {
        const ms = Number(c?.startTime || 0);
        if (ms > 0) by.set(String(c.id), ms);
      }
      for (const t of slice) {
        const ms = by.get(String(t.external_id)) ?? null;
        record(t, ms, ms ? null : '平台没给副歌点');
        if (ms) got += 1; else none += 1;
      }
    } catch (e) {
      failed += slice.length;
      console.log('  网易云这批失败(留待重跑): ' + e.message);
    }
    flush();
    console.log('  网易云 ' + Math.min(i + NE_BATCH, ne.length) + '/' + ne.length + '  有 ' + got);
    await sleep(NE_PACE_MS);
  }

  // ---- QQ ----
  if (qq.length) {
    const cookie = loadCookie();
    if (!cookie) {
      console.log('没有 QQ cookie, 跳过 QQ ' + qq.length + ' 首。');
    } else {
      for (let i = 0; i < qq.length; i += 1) {
        const t = qq[i];
        try {
          const { ms, note } = await qqChorus(t, cookie);
          record(t, ms, note);
          if (ms) got += 1; else none += 1;
        } catch (e) {
          if (e.fatal) {
            flush();
            console.log('\n★ ' + e.message + ' —— 停下来了, 换新 cookie 后重跑即可续上。');
            break;
          }
          failed += 1;
          // 不记录 = 没问过, 下次自动重试。
        }
        if ((i + 1) % 50 === 0 || i === qq.length - 1) {
          flush();
          const pct = (((i + 1) / qq.length) * 100).toFixed(1);
          console.log('  QQ ' + (i + 1) + '/' + qq.length + ' (' + pct + '%)'
            + '  有 ' + got + '  无 ' + none + '  失败 ' + failed);
        }
        if ((i + 1) % QQ_REST_EVERY === 0 && i < qq.length - 1) {
          console.log('  ... 歇 ' + (QQ_REST_MS / 1000) + ' 秒');
          await sleep(QQ_REST_MS);
        }
        await sleep(jitter(QQ_PACE_MS));
      }
    }
  }

  flush();
  console.log('\n本轮完成。有副歌点 ' + got + ', 平台没有 ' + none + ', 失败留待重跑 ' + failed);
  console.log('累计已问 ' + Object.keys(results).length + ' 首, 结果在 ' + OUT_FILE);
})().catch((e) => { flush(); console.error('出错: ' + e.message); process.exitCode = 1; });
