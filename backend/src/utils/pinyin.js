const pinyinMod = require('pinyin');
const pinyinFn = pinyinMod.pinyin || pinyinMod.default || pinyinMod;

// Style constants: 0 = NORMAL (full pinyin), 4 = FIRST_LETTER (initials)
const STYLE_NORMAL = 0;
const STYLE_FIRST_LETTER = 4;

/**
 * Convert Chinese text to full pinyin with spaces.
 * e.g. "月亮代表我的心" → "yue liang dai biao wo de xin"
 */
function toPinyin(chinese) {
  if (!chinese) return null;
  return pinyinFn(chinese, { style: STYLE_NORMAL })
    .map((p) => p[0])
    .join(' ');
}

/**
 * Convert Chinese text to pinyin initials.
 * e.g. "月亮代表我的心" → "yldbwdx"
 */
function toPinyinInitials(chinese) {
  if (!chinese) return null;
  return pinyinFn(chinese, { style: STYLE_FIRST_LETTER })
    .map((p) => p[0])
    .join('');
}

/**
 * Convert Chinese text to pinyin without spaces (concatenated).
 * e.g. "月亮代表我的心" → "yueliangdaibiaowodexin"
 */
function toPinyinConcat(chinese) {
  if (!chinese) return null;
  return pinyinFn(chinese, { style: STYLE_NORMAL })
    .map((p) => p[0])
    .join('');
}

/**
 * Convert Chinese text to a flat string of all possible pinyin readings.
 * For polyphonic characters, all readings are included (deduplicated).
 * e.g. "音乐" → "yin le yue yao lao"  (乐 has multiple readings)
 * Used for fuzzy/trigram search to match any valid pronunciation.
 */
function toPinyinAll(chinese) {
  if (!chinese) return null;
  const readings = pinyinFn(chinese, { style: STYLE_NORMAL, heteronym: true });
  const allPinyin = [];
  for (const charReadings of readings) {
    for (const r of charReadings) {
      // Strip tone marks to plain ASCII pinyin
      const plain = r.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (!allPinyin.includes(plain)) {
        allPinyin.push(plain);
      }
    }
  }
  return allPinyin.join(' ');
}

/**
 * Generate all possible pinyin initial combinations for polyphonic characters.
 * Returns pipe-delimited string of all variants.
 * e.g. "侠行天龙" → "xhtl|xxtl"  (行 = h or x)
 * Most songs produce 1-4 variants. Capped at 16 to prevent explosion.
 */
function toPinyinInitialsAll(chinese) {
  if (!chinese) return null;
  const readings = pinyinFn(chinese, { style: STYLE_FIRST_LETTER, heteronym: true });
  // Deduplicate initials per character
  const perChar = readings.map((r) => [...new Set(r)]);

  // Generate all combinations via iterative cartesian product
  let combos = [''];
  for (const chars of perChar) {
    const next = [];
    for (const prefix of combos) {
      for (const ch of chars) {
        next.push(prefix + ch);
      }
    }
    combos = next;
    if (combos.length > 16) break; // safety cap
  }

  return [...new Set(combos)].join('|');
}

module.exports = { toPinyin, toPinyinInitials, toPinyinConcat, toPinyinAll, toPinyinInitialsAll };
