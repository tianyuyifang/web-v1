/**
 * One lowercase string a search box can substring-match against.
 *
 * Built for lists that live in memory rather than in a table (the platform
 * playlists of 平台打标), where pg_trgm is not available: the text itself, its
 * full pinyin and initials in the default reading, and every polyphonic
 * variant of both. "zjl", "qingtian" and "晴" all land on the same row; 音乐
 * answers to "yinyue" and "yinle".
 *
 * The default-reading spellings are uncapped and always present, so a long
 * title is always findable in full. The variants are capped (see
 * toPinyinConcatAll) and only add alternatives on top.
 */
const {
  toPinyinConcat, toPinyinInitials, toPinyinConcatAll, toPinyinInitialsAll,
} = require('./pinyin');

const HAN = /[㐀-鿿]/;

function searchTextFor(...parts) {
  // The raw text goes in whole, so a phrase typed with its spaces ("la la")
  // still matches as a phrase. Only the pinyin spellings are tokenised.
  const raw = [];
  const pinyin = [];
  for (const p of parts) {
    const text = String(p || '').trim();
    if (!text) continue;
    raw.push(text.toLowerCase());
    if (HAN.test(text)) {
      pinyin.push(toPinyinConcat(text) || '');
      pinyin.push(toPinyinInitials(text) || '');
      pinyin.push((toPinyinConcatAll(text) || '').replace(/\|/g, ' '));
      pinyin.push((toPinyinInitialsAll(text) || '').replace(/\|/g, ' '));
    }
  }
  const tokens = [...new Set(pinyin.join(' ').toLowerCase().split(/\s+/).filter(Boolean))];
  return [...raw, ...tokens].join(' ');
}

module.exports = { searchTextFor };
