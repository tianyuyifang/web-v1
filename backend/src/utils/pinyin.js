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

module.exports = { toPinyin, toPinyinInitials, toPinyinConcat };
