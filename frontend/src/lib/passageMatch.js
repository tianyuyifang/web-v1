/**
 * 唱卡歌词匹配算法 —— 前端渲染与后端审核页共用同一份。
 *
 * ## 两步法（2026-09-07 重写）
 *
 * 旧算法是「一条游戏行 ↔ 一条歌词行」的逐行匹配。那个结构跟真实数据
 * 对不上：游戏按「唱句」拆行，平台 LRC 按「时间戳」拆行，两边行边界不一致
 * 的段落占 27.7%（多对一 21.5% + 一对多 5.5%）。合成样本实测，旧算法在
 * 多对一上只有 0.1% —— 一条游戏行横跨两条歌词行时，拿整行去比任何
 * 单行都只对得上一半，结构上就匹配不了。
 *
 * 现在分两步，两件事互不干扰：
 *
 *   第一步 定序 —— 只回答「这几行按什么次序拼」
 *     遮掩段   → 原序（实测 816/816 单调；游戏不会又遮又乱）
 *     无遮掩段 → 每行在平台歌词里定位，按位置排序
 *
 *   第二步 匹配 —— 按该次序拼成一条串，在平台长串上滑窗打分
 *     行边界在拼串后消失，所以一对多 / 多对一自然解消 ——
 *     它们本来就只是同一串字符的不同切法。
 *
 * 第二步**不再改动顺序**。曾把两者控制在一起（用匹配得分去裁决顺序），
 * 结果不受约束的那条路得分天然更高，顺序约束必然被淡化。
 *
 * ## 实测（三套独立测试，都没用于调参）
 *
 * | | 旧算法 | 两步法 |
 * |---|---|---|
 * | 99 条人工确认答案 | 19 | 59 |
 * | 合成样本·原样 | 66.7% | 97.9% |
 * | 合成样本·乱序 | 66.7% | 91.6% |
 * | 合成样本·遮掩 | 54.6% | 96.0% |
 * | 合成样本·一对多 | 59.1% | 98.7% |
 * | 合成样本·多对一 | 0.1% | 97.3% |
 * | 合成样本·错一个字 | 66.7% | 94.4% |
 * | 定序准确率（3900 对，真值来自同段遮掩变体） | — | 92.36% |
 *
 * 而且比旧算法更快（99 条 369ms → 236ms）。
 */
/* eslint-disable */
/**
 * 定序 —— A 与 B 两种, 都加连续性约束。
 *
 * 共同的核心: 段落是连着唱的, 所以各行必须落在一段**相邻区间**内,
 * 且同一位置不能被两行占用(这样文字相同的两行会被自动分开)。
 *
 * A(orderOnlyA): 用连续区间推出次序, **丢掉位置**, 只返回排列。
 * B(orderPosB):  同一次计算里把次序和位置都定下来, 一并返回。
 */
function norm(s) {
  return String(s || "")
    .replace(/[\s,.!?;:，。！？；：、"'"'()（）\[\]]/g, "")
    .toLowerCase();
}
function latinLine(s) { return /^[\x00-\x7F\s_]*$/.test(String(s || "")); }
function expand(gameLine) {
  const s = String(gameLine || "").trim();
  const latin = latinLine(s);
  const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " ") { i += 1; continue; }
    if (c === "_") {
      let run = 0;
      while (i < s.length && s[i] === "_") { run += 1; i += 1; }
      const n = latin ? run : 1;
      for (let k = 0; k < n; k += 1) out.push(null);
      continue;
    }
    const nc = norm(c);
    if (nc) out.push(nc);
    i += 1;
  }
  return out;
}
function buildHay(parsed) {
  const hay = []; const owner = [];
  parsed.forEach((p, i) => { for (const ch of norm(p.text)) { hay.push(ch); owner.push(i); } });
  return { hay, owner };
}
function rateAt(seq, hay, off) {
  let hit = 0;
  for (let k = 0; k < seq.length; k += 1) {
    const w = seq[k], g = hay[off + k];
    if (w === null || (g !== undefined && g === w)) hit += 1;
  }
  return hit / seq.length;
}
/** 一行在 hay 里所有达标位置, 按得分降序。 */
function candsOf(seq, hay, minRate, cap) {
  const out = [];
  if (!seq.length) return out;
  for (let off = 0; off + seq.length <= hay.length; off += 1) {
    const r = rateAt(seq, hay, off);
    if (r >= minRate) out.push({ off, r });
  }
  out.sort((a, b) => b.r - a.r || a.off - b.off);
  return out.slice(0, cap);
}
/**
 * 在一个连续区间 [lo,hi) 内给各行分配互不重叠的位置。
 * 贪心: 按候选得分高的行先挑, 已占用的字符段不能再被占。
 */
function assignInWindow(seqs, cands, lo, hi) {
  const G = seqs.length;
  const taken = [];
  const order = [...Array(G).keys()].sort((a, b) => {
    const ra = cands[a].length ? cands[a][0].r : 0;
    const rb = cands[b].length ? cands[b][0].r : 0;
    return rb - ra;
  });
  const pos = new Array(G).fill(null);
  let score = 0, wtot = 0;
  for (const i of order) {
    let pick = null;
    for (const c of cands[i]) {
      if (c.off < lo || c.off + seqs[i].length > hi) continue;
      let clash = false;
      for (const t of taken) { if (c.off < t[1] && c.off + seqs[i].length > t[0]) { clash = true; break; } }
      if (clash) continue;
      pick = c; break;
    }
    if (pick) { taken.push([pick.off, pick.off + seqs[i].length]); pos[i] = pick; score += pick.r * seqs[i].length; }
    wtot += seqs[i].length;
  }
  return { pos, rate: wtot ? score / wtot : 0 };
}
/** 找最佳连续区间 + 区间内的分配。 */
function bestWindow(gameLines, parsed, cfg) {
  const c = cfg || {};
  const G = gameLines.length;
  const seqs = gameLines.map(expand);
  const { hay, owner } = buildHay(parsed);
  if (!hay.length || seqs.every((s) => !s.length)) return null;
  const cands = seqs.map((s) => candsOf(s, hay, c.lineRate ?? 0.6, c.maxCand ?? 10));
  const anyCand = cands.some((x) => x.length);
  if (!anyCand) return null;
  const totalLen = seqs.reduce((a, s) => a + s.length, 0);
  const span = Math.ceil(totalLen * (c.spanFactor ?? 1.6)) + 10;
  // 候选起点: 所有行的候选位置各自当一次区间起点
  const starts = new Set();
  for (const cs of cands) for (const x of cs) {
    starts.add(Math.max(0, x.off - span + seqs[0].length));
    starts.add(x.off);
  }
  let best = null;
  for (const st of starts) {
    const lo = Math.max(0, st), hi = Math.min(hay.length, st + span);
    if (hi - lo < totalLen * 0.5) continue;
    const a = assignInWindow(seqs, cands, lo, hi);
    const placed = a.pos.filter(Boolean).length;
    if (!placed) continue;
    if (!best || a.rate > best.rate || (a.rate === best.rate && placed > best.placed)) {
      best = { rate: a.rate, pos: a.pos, placed, lo, hi };
    }
  }
  if (!best) return null;
  return { ...best, seqs, hay, owner };
}
/** 由位置得出次序; 定位不到的按原相对位置插回。 */
function orderFromPos(pos, G) {
  const base = [...Array(G).keys()];
  const known = base.filter((i) => pos[i]).sort((a, b) => pos[a].off - pos[b].off);
  const unknown = base.filter((i) => !pos[i]);
  const out = []; let u = 0;
  for (const k of known) {
    while (u < unknown.length && unknown[u] < k) { out.push(unknown[u]); u += 1; }
    out.push(k);
  }
  while (u < unknown.length) { out.push(unknown[u]); u += 1; }
  return out;
}
/** A: 只返回次序, 丢掉位置。 */
function orderOnlyA(gameLines, parsed, cfg) {
  const G = gameLines.length;
  const base = [...Array(G).keys()];
  if (gameLines.some((g) => String(g).includes("_"))) return { order: base, why: "masked" };
  const w = bestWindow(gameLines, parsed, cfg);
  if (!w) return { order: base, why: "no-window" };
  return { order: orderFromPos(w.pos, G), why: "window" };
}
/** B: 次序与位置一并返回。 */
function orderPosB(gameLines, parsed, cfg) {
  const G = gameLines.length;
  const base = [...Array(G).keys()];
  if (gameLines.some((g) => String(g).includes("_"))) {
    const w0 = bestWindow(gameLines, parsed, cfg);
    return { order: base, pos: w0 ? w0.pos : null, w: w0, why: "masked" };
  }
  const w = bestWindow(gameLines, parsed, cfg);
  if (!w) return { order: base, pos: null, w: null, why: "no-window" };
  return { order: orderFromPos(w.pos, G), pos: w.pos, w, why: "window" };
}

const D = { HIT: 10, MISS: -10, minRate: 0.3 };

export function markPassage(gameLyric, parsed, cfg) {
  const c = Object.assign({}, D, cfg || {});
  if (!gameLyric || !parsed.length) return [];
  const gameLines = gameLyric.split(/[\n\/]+/).map((l) => l.trim()).filter(Boolean);
  if (!gameLines.length) return [];
  const G = gameLines.length;
  const seqs = gameLines.map(expand);
  if (seqs.every((s) => !s.length)) return [];

  // 第一步: 定序
  const ord = orderOnlyA(gameLines, parsed, c).order;

  // 第二步: 按该次序拼接
  const { hay, owner } = buildHay(parsed);
  if (!hay.length) return [];
  const seq = []; const bounds = [];
  for (const gi of ord) {
    const st = seq.length;
    for (const x of seqs[gi]) seq.push(x);
    bounds.push({ gi, st, en: seq.length });
  }
  if (!seq.length || seq.length > hay.length) return [];

  // 滑窗打分
  let best = null;
  for (let off = 0; off + seq.length <= hay.length; off += 1) {
    let sc = 0;
    for (let k = 0; k < seq.length; k += 1) {
      const w = seq[k], g = hay[off + k];
      if (w === null || g === w) sc += c.HIT; else sc += c.MISS;
    }
    const rate = sc / (seq.length * c.HIT);
    if (rate < c.minRate) continue;
    if (!best || rate > best.rate) best = { rate, off };
  }
  if (!best) return [];

  // 映射回行号
  const chosen = new Array(G).fill(-1);
  for (const b of bounds) {
    const rows = [];
    for (let q = best.off + b.st; q < best.off + b.en && q < owner.length; q += 1) {
      if (!rows.length || rows[rows.length - 1] !== owner[q]) rows.push(owner[q]);
    }
    chosen[b.gi] = rows.length === 0 ? -1 : (rows.length === 1 ? rows[0] : rows);
  }
  return [chosen];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { markPassage };
}
