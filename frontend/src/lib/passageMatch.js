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


/*
 * ===== 兜底：旧的逐行匹配算法，原样保留 =====
 *
 * 拼串是刚性的：一处增删字就让后面整体错位，整段得分崩掉。
 * 逐行匹配扛得住（一行对不上只丢那一行），所以拼串法给不出答案时回退到它。
 * 实测「增删字」档：拼串法零标 869 个，旧算法在其中 684 个完全答对、
 * 184 个能给出附近的黄点，只有 1 个完全标错。
 *
 * 与其没有黄点，不如给个大致对的。辅助函数加 lg_ 前缀避免与新实现冲突。
 */

const lg_MATCH_RATIO = 0.66;

/** Shortest game line worth matching: below this, everything matches. */
const lg_MIN_LINE_CHARS = 4;

function lg_normalise(s) {
  return String(s || "")
    .replace(/[\s,.!?;:，。！？；：、"'"'()（）\[\]]/g, "")
    .toLowerCase();
}

/**
 * How far a masked line's length may differ from the real line's.
 *
 * Zero would do: measured against reference lines identified independently, a
 * mask block predicted the length exactly in 15 of 20 cases, and the other
 * five were the platform writing two sung lines as one. The slack is only for
 * punctuation the two sides render differently, and widening it to 3 or
 * narrowing it to 0 changed nothing across the whole ground-truth set.
 */
const lg_LENGTH_SLACK = 2;

/**
 * Split a game line into character slots, one per character of the real line.
 *
 * The game writes a hidden character as a run of underscores, so a run counts
 * as one character rather than as its own length. That is what lets a line
 * showing a single character still say how long it is — and length is most of
 * what such a line has to offer.
 */
function lg_slotsOf(gameLine) {
  const s = String(gameLine == null ? "" : gameLine).trim();
  const slots = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " ") { i += 1; continue; }
    if (c === "_") {
      while (i < s.length && s[i] === "_") i += 1;
      slots.push(null);
      continue;
    }
    slots.push(c);
    i += 1;
  }
  return slots;
}

/** Every visible character present, in order. */
function lg_visibleInOrder(chars, real) {
  let hits = 0;
  let at = 0;
  for (const ch of chars) {
    const found = real.indexOf(ch, at);
    if (found >= 0) { hits += 1; at = found + 1; }
  }
  return hits;
}

/**
 * Does a game line correspond to this real line?
 *
 * Two cases, because a masked line and an unmasked one carry different
 * evidence.
 *
 * Unmasked: unchanged — the visible characters must appear in order, two
 * thirds of them at least, which tolerates the game's own misspellings.
 *
 * Masked: the line used to be thrown away. Deleting the underscores left "春"
 * from "春 __ __ __ __", one character, below the minimum, so the heaviest
 * masking — 85% of masked lines show a single character — matched nothing at
 * all. Counting the runs instead recovers the line's length, which is enough
 * to place it: "春" plus "five characters long" finds 春去春又回. Every visible
 * character must then be present, since the mask hides characters rather than
 * altering them.
 *
 * Characters are compared as code points throughout. Rare Han characters live
 * outside the BMP, where `.length` counts them twice and halved the ratio —
 * failing the threshold on exactly the characters that identify a line best.
 */
function lg_linesMatch(gameLine, realLine) {
  const real = [...lg_normalise(realLine)];
  if (!real.length) return false;

  const slots = lg_slotsOf(gameLine);
  const masked = slots.filter((c) => c === null).length;
  const shown = [...lg_normalise(slots.filter((c) => c !== null).join(""))];

  if (!masked) {
    if (shown.length < lg_MIN_LINE_CHARS) return false;
    return lg_visibleInOrder(shown, real) / shown.length >= lg_MATCH_RATIO;
  }

  if (!shown.length) return false;
  if (Math.abs(real.length - slots.length) > lg_LENGTH_SLACK) return false;
  return lg_visibleInOrder(shown, real) === shown.length;
}

/**
 * How much wider than the passage a window may be.
 *
 * Slack for the platform splitting a sung line in two. Sweeping this between 2
 * and 6 changed no result in the ground-truth set, so it is loose on purpose.
 */
const lg_WINDOW_SLACK = 4;

/** How many characters a line holds, a mask run counting as the one it hides. */
function lg_lengthOf(text) {
  return lg_slotsOf(text).length;
}

/**
 * Give each game line a real line within the window, without overfilling one.
 *
 * Each line used to pick the first candidate inside the window on its own,
 * knowing nothing of what the others had taken. Where a song repeats itself —
 * and songs repeat themselves constantly — that put several game lines on the
 * same real line and left the rest of the run unmarked: 「大海」 placed six
 * lines onto three, both 「所有受过的伤」 and 「所有流过的泪」 landing on 「所有
 * 受过的伤」 while 「所有流过的泪」 sat unclaimed on the next line.
 *
 * Sharing a line cannot simply be forbidden: it is often right, because the
 * platform writes as one line what the game shows as two — the same 「大海」 has
 * 「如果大海能够」 and 「带走我的哀愁」 correctly sharing one twelve-character
 * line. What separates the two cases is length. A real line holds about as many
 * characters as it has; a second game line fits only if room is left.
 *
 * So each line takes the first candidate that still has room, and the room it
 * uses is its own length. Measured over 7,085 passages: 493 improved, 211 more
 * lines placed, none lost, and the twenty-six the metric flagged as worse were
 * read by hand and were improvements too — the flag was counting backward steps,
 * which are normal in a passage the game shuffled.
 */
function lg_assignWithinWindow(candidates, start, width, gameLines, parsed) {
  const room = new Map();
  return candidates.map((hits, gi) => {
    const inside = hits.filter((i) => i >= start && i < start + width);
    const want = lg_lengthOf(gameLines[gi]);
    let pick = -1;
    for (const i of inside) {
      if (!room.has(i)) room.set(i, [...lg_normalise(parsed[i].text)].length + lg_LENGTH_SLACK);
      if (room.get(i) >= want) { pick = i; break; }
    }
    // Nothing has room: take the first candidate anyway. A line marked twice is
    // the old behaviour, and better than a line the singer cannot see at all.
    if (pick < 0 && inside.length) pick = inside[0];
    if (pick >= 0) room.set(pick, room.get(pick) - want);
    return pick;
  });
}

/**
 * Where the game's passage sits in the real lyrics.
 *
 * Returns every distinct place it occurs, earliest first, each an array of
 * line indexes parallel to the game's own lines (-1 where a line found
 * nothing).
 *
 * What changed and why. Each game line used to search the whole song alone and
 * take the first line it matched. That threw away the strongest thing known
 * about a passage: it is sung as a run, so the lines it covers are adjacent.
 * Measured on 117 real passages, 99% are contiguous — and the exceptions were
 * the matcher's own errors, not passages that genuinely scatter. Judged
 * per-line, a repeated chorus made the choice a coin flip, and a line matching
 * the "title - artist" header at the top of the file beat the real one 14
 * times.
 *
 * So contiguity is a gate rather than a preference: a placement whose lines
 * have a gap is not a worse answer, it is not an answer. Among those that
 * pass, the one accounting for the most game lines wins, and the earliest wins
 * a tie. The header needs no special case — it sits alone at the top, so no
 * contiguous window reaches both it and the passage.
 *
 * Order inside a window is not assumed. The game shuffles what it shows; one
 * real passage arrived as lines 14, 16, 17, 15, 13.
 */
function legacyMarkPassage(gameLyric, parsed) {
  if (!gameLyric || !parsed.length) return [];
  const gameLines = gameLyric
    .split(/[\n\/]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!gameLines.length) return [];

  const candidates = gameLines.map((line) => {
    const hits = [];
    parsed.forEach((p, i) => { if (lg_linesMatch(line, p.text)) hits.push(i); });
    return hits;
  });
  if (candidates.every((c) => !c.length)) return [];

  // A window may be narrower than the passage: the platform sometimes writes
  // as one line what the game shows as two.
  const minWidth = Math.max(1, Math.ceil(gameLines.length / 2));
  const maxWidth = gameLines.length + lg_WINDOW_SLACK;

  let best = -1;
  let placements = [];
  for (let width = minWidth; width <= maxWidth; width += 1) {
    for (let start = 0; start + width <= parsed.length; start += 1) {
      const chosen = lg_assignWithinWindow(candidates, start, width, gameLines, parsed);
      const used = [...new Set(chosen.filter((i) => i >= 0))].sort((a, b) => a - b);
      if (!used.length) continue;
      // The gate. A gap means these lines are not one passage.
      if (used[used.length - 1] - used[0] !== used.length - 1) continue;

      const placed = chosen.filter((i) => i >= 0).length;
      if (placed > best) { best = placed; placements = [{ chosen, used, at: used[0] }]; }
      else if (placed === best) placements.push({ chosen, used, at: used[0] });
    }
  }
  if (!placements.length) return [];

  // Earliest first, and each place claims its lines: without that, a window
  // sliding along by one produced a family of near-duplicates that read as
  // nine occurrences of a chorus which occurs twice.
  placements.sort((a, b) => a.at - b.at);
  const claimed = new Set();
  const places = [];
  for (const p of placements) {
    if (p.used.some((i) => claimed.has(i))) continue;
    p.used.forEach((i) => claimed.add(i));
    places.push(p.chosen);
  }
  return places;
}


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
  // 收集**每一处**达标的位置，不只取最高分那一处。
  //
  // 副歌唱三遍就该标三处 —— 唱卡页把所有出现处都标黄，
  // 用户唱到第二遍副歌时也要看得到高亮。只返回一处的那版上线
  // 后立刻被用户发现：青花瓷 3 处→ 1 处、花香 3 处→ 1 处。
  // 收集**每一处**达标的位置，不只取最高分那一处。
  // 副歌唱三遍就该标三处 —— 只返回一处的那版上线后立刻被
  // 用户发现：青花瓷 3 处→ 1 处、花香 3 处→ 1 处。
  //
  // 通配位（遮掩位）**不算证据也不计入分母**。它只贡献「长度」
  // 这一个约束，而不说明落在哪里对。把它当必中（+HIT）会让一条
  // 几乎全遮掩的段落在**任何位置**都拿满分，滑窗没有峰值；
  // 只取最高分时还看不出来，改成收集所有达标处后就会把整首歌
  // 都标上（实测遮掩档从 41% 崩到 0.1%）。
  const hits = [];
  for (let off = 0; off + seq.length <= hay.length; off += 1) {
    let sc = 0;
    let vis = 0;
    for (let k = 0; k < seq.length; k += 1) {
      const w = seq[k], g = hay[off + k];
      if (w === null) continue;            // 通配位：不计分也不计分母
      vis += 1;
      if (g === w) sc += c.HIT; else sc += c.MISS;
    }
    if (!vis) continue;                    // 整段全是通配位：无从判断，宁可不标
    const rate = sc / (vis * c.HIT);
    if (rate < c.minRate) continue;
    hits.push({ rate: rate, off: off });
  }
  if (!hits.length) return legacyMarkPassage(gameLyric, parsed);

  // 得分高的先选，每处认领自己盖到的行 —— 否则窗口滑一格就
  // 产生一堆几乎重叠的重复项，一段副歌会读成十几处。
  // 「算不算另一处」要和**最佳处**比，不能和绝对阈值比。
  //
  // minRate 是「值不值得标」的下限，拿它当「算不算另一处」的判据，
  // 噪声就混进来了：实测一个 6 行段落，真正那处 rate=1.000，
  // 另一处 rate=0.619（只对了六成）也过了 0.3，两处又不共用行，
  // 于是多标了 6 行。原样档失败的 21 个里 20 个是这个原因。
  //
  // 旧算法实际上用的就是相对比较（取 placed 最多的窗口，平局才并存）。
  // 副歌唱三遍时各处得分都接近 1.0，会全部保留；噪声处相对太低，排除。
  hits.sort(function (a, b) { return b.rate - a.rate || a.off - b.off; });
  const bestRate = hits[0].rate;
  const keepFloor = bestRate * (c.nearBest === undefined ? 0.9 : c.nearBest);
  const claimed = new Set();
  const kept = [];
  for (const h of hits) {
    if (h.rate < keepFloor) break;   // 已按得分降序，后面只会更低
    const rows = new Set();
    for (let q = h.off; q < h.off + seq.length && q < owner.length; q += 1) rows.add(owner[q]);
    let clash = false;
    for (const r of rows) { if (claimed.has(r)) { clash = true; break; } }
    if (clash) continue;
    for (const r of rows) claimed.add(r);
    kept.push(h);
  }
  // 靠前的在前：页面滚动到最靠前那一处。
  kept.sort(function (a, b) { return a.off - b.off; });

  const places = [];
  for (const h of kept) {
    const chosen = new Array(G).fill(-1);
    for (const b of bounds) {
      const rows = [];
      for (let q = h.off + b.st; q < h.off + b.en && q < owner.length; q += 1) {
        if (!rows.length || rows[rows.length - 1] !== owner[q]) rows.push(owner[q]);
      }
      chosen[b.gi] = rows.length === 0 ? -1 : (rows.length === 1 ? rows[0] : rows);
    }
    places.push(chosen);
  }
  return places;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { markPassage };
}
