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

console.log('Test: Rule 2 clipCut');
{
  // same song s1, different clip ids: A has cA, B has cB
  const a = [pc({ clipId: 'cA', songId: 's1', speed: 1.0, pitch: 2, colorTag: '#E8655A', comment: 'A-note', sectionLabel: 'A-sec' })];
  const b = [pc({ clipId: 'cB', songId: 's1', speed: 1.3, pitch: -1, colorTag: '#4CAF50', comment: 'B-note', sectionLabel: 'B-sec' })];

  // clipCut="A" (default): keep A's clip, flag [B 中的片段不同]
  const da = buildMergeRows(a, b).rows;
  check('clipCut=A keeps A clip', da[0].clipId === 'cA');
  check('clipCut=A flagged', da[0].comment.includes('[B 中的片段不同]'));
  check('clipCut=A markedDifferent', buildMergeRows(a, b).summary.markedDifferent === 1);

  // clipCut="B": emit B's clip, options-resolved fields, append [已采用 B 的片段]
  const { rows, summary } = buildMergeRows(a, b, { clipCut: 'B', comment: 'A', speed: 'B', pitch: 'A' });
  check('clipCut=B uses B clipId', rows[0].clipId === 'cB');
  check('clipCut=B speed=B', rows[0].speed === 1.3);
  check('clipCut=B pitch=A', rows[0].pitch === 2);
  check('clipCut=B comment resolved+annotated', rows[0].comment === 'A-note\n[已采用 B 的片段]');
  check('clipCut=B no leftover A row', rows.length === 1);
  check('clipCut=B not counted as deleted', summary.markedDeleted === 0);
}

console.log('Test: order option');
{
  // A: [s1(cA1), s2(cA2)] ; B: [s2(cB2 same clip as cA2), s3(cB3 new)]
  const a = [
    pc({ clipId: 'cA1', songId: 's1' }),
    pc({ clipId: 'cA2', songId: 's2' }),
  ];
  const b = [
    pc({ clipId: 'cA2', songId: 's2' }),  // Rule 4 match
    pc({ clipId: 'cB3', songId: 's3' }),  // Rule 1 added
  ];

  const bOrder = buildMergeRows(a, b, { order: 'B' });
  // B-order: matched/added in B's order [s2, s3], then A-only [s1] at bottom
  check('B-order seq', bOrder.rows.map(r => r.clipId).join(',') === 'cA2,cB3,cA1');

  const aOrder = buildMergeRows(a, b, { order: 'A' });
  // A-order: A's order [s1, s2], then new-in-B [s3] at bottom
  check('A-order seq', aOrder.rows.map(r => r.clipId).join(',') === 'cA1,cA2,cB3');

  // summary identical regardless of order
  check('summary added equal', bOrder.summary.added === aOrder.summary.added);
  check('summary merged equal', bOrder.summary.merged === aOrder.summary.merged);
  check('summary markedDeleted equal', bOrder.summary.markedDeleted === aOrder.summary.markedDeleted);

  // returned rows must not leak provenance markers
  check('no provenance leak', Object.keys(bOrder.rows[0]).sort().join(',') === 'clipId,colorTag,comment,pitch,sectionLabel,speed');
}

console.log('Test: defaults reproduce legacy behavior across all rules');
{
  const a = [
    pc({ clipId: 'm1', songId: 's1', speed: 1.0, pitch: 4, colorTag: '#E8655A', comment: 'keepA', sectionLabel: 'aSec' }), // Rule 4
    pc({ clipId: 'd1', songId: 's2', comment: 'orig' }),                                                                    // Rule 2 (diff clip)
    pc({ clipId: 'x1', songId: 's4', comment: 'gone' }),                                                                    // Rule 5 (deleted)
  ];
  const b = [
    pc({ clipId: 'm1', songId: 's1', speed: 1.2, pitch: -3, colorTag: '#4CAF50', comment: 'B', sectionLabel: 'bSec' }),     // Rule 4
    pc({ clipId: 'd2', songId: 's2', comment: 'bDiff' }),                                                                    // Rule 2 (diff clip, same song)
    pc({ clipId: 'n1', songId: 's3', comment: 'newB' }),                                                                     // Rule 1 (added)
  ];

  const omitted = buildMergeRows(a, b);
  const explicit = buildMergeRows(a, b, { speed:'B', pitch:'A', comment:'A', colorTag:'combine', sectionLabel:'B', clipCut:'A', order:'B' });
  check('omitted == explicit defaults', JSON.stringify(omitted) === JSON.stringify(explicit));

  // Legacy expectations:
  const byClip = Object.fromEntries(omitted.rows.map(r => [r.clipId, r]));
  check('Rule4 speed=B', byClip['m1'].speed === 1.2);
  check('Rule4 pitch=A', byClip['m1'].pitch === 4);
  check('Rule4 comment=A', byClip['m1'].comment === 'keepA');
  check('Rule4 colorTag=union', byClip['m1'].colorTag === '#E8655A|#4CAF50');
  check('Rule4 sectionLabel=B', byClip['m1'].sectionLabel === 'bSec');
  check('Rule2 keeps A clip d1 + flag', byClip['d1'].comment.includes('[B 中的片段不同]'));
  check('Rule1 added n1', !!byClip['n1']);
  check('Rule5 deleted x1 flagged', byClip['x1'].comment.includes('[此歌已删]'));
  check('Rule5 at bottom', omitted.rows[omitted.rows.length - 1].clipId === 'x1');
  check('summary', JSON.stringify(omitted.summary) === JSON.stringify({ added: 1, merged: 1, markedDifferent: 1, markedDeleted: 1 }));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
