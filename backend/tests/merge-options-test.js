// Unit tests for configurable merge options in buildMergeRows.
// Run: node tests/merge-options-test.js
const {
  buildMergeRows, DEFAULT_MERGE_OPTIONS, normalizeOptions, pick, combineComment,
} = require('../src/services/mergeService');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name}`); }
}

// Build a playlistClip row like prisma returns (clip nests id + songId).
function pc({ clipId, songId, speed = 1, pitch = 0, colorTag = null, comment = null, sectionLabel = null }) {
  return { clipId, speed, pitch, colorTag, comment, sectionLabel, clip: { id: clipId, songId } };
}

console.log('Test: pick()');
check('pick A', pick('A', 'a', 'b') === 'a');
check('pick B', pick('B', 'a', 'b') === 'b');
check('pick combine', pick('combine', 'a', 'b', (x, y) => x + y) === 'ab');

console.log('Test: combineComment()');
check('both empty -> null', combineComment(null, '') === null);
check('A only', combineComment('hi', null) === 'hi');
check('B only', combineComment('', 'yo') === 'yo');
check('A then B joined', combineComment('hi', 'yo') === 'hi\nyo');
check('duplicate not doubled', combineComment('hi', 'hi') === 'hi');

console.log('Test: normalizeOptions() fills defaults');
{
  const n = normalizeOptions({ speed: 'A' });
  check('override kept', n.speed === 'A');
  check('missing filled', n.pitch === DEFAULT_MERGE_OPTIONS.pitch);
  check('all 7 present', ['speed','pitch','comment','colorTag','sectionLabel','clipCut','order'].every(k => k in n));
}

console.log('Test: Rule 4 (same clip.id) honors options');
{
  const a = [pc({ clipId: 'c1', songId: 's1', speed: 1.0, pitch: 3, colorTag: '#E8655A', comment: 'A-note', sectionLabel: 'A-sec' })];
  const b = [pc({ clipId: 'c1', songId: 's1', speed: 1.2, pitch: -2, colorTag: '#4CAF50', comment: 'B-note', sectionLabel: 'B-sec' })];
  // defaults: speed=B, pitch=A, comment=A, colorTag=combine, sectionLabel=B
  const { rows, summary } = buildMergeRows(a, b);
  check('merged count 1', summary.merged === 1);
  check('default speed=B', rows[0].speed === 1.2);
  check('default pitch=A', rows[0].pitch === 3);
  check('default comment=A', rows[0].comment === 'A-note');
  check('default colorTag=union', rows[0].colorTag === '#E8655A|#4CAF50');
  check('default sectionLabel=B', rows[0].sectionLabel === 'B-sec');

  const opts = { speed: 'A', pitch: 'B', comment: 'B', colorTag: 'A', sectionLabel: 'A' };
  const r2 = buildMergeRows(a, b, opts).rows[0];
  check('opt speed=A', r2.speed === 1.0);
  check('opt pitch=B', r2.pitch === -2);
  check('opt comment=B', r2.comment === 'B-note');
  check('opt colorTag=A', r2.colorTag === '#E8655A');
  check('opt sectionLabel=A', r2.sectionLabel === 'A-sec');

  const r3 = buildMergeRows(a, b, { comment: 'combine' }).rows[0];
  check('opt comment=combine', r3.comment === 'A-note\nB-note');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
