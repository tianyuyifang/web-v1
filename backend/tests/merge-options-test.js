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

// Build a playlistClip row like prisma returns (clip nests id + songId + song.title).
function pc({ clipId, songId, title, speed = 1, pitch = 0, colorTag = null, comment = null, sectionLabel = null }) {
  const clip = { id: clipId, songId };
  if (title !== undefined) clip.song = { title };
  return { clipId, speed, pitch, colorTag, comment, sectionLabel, clip };
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
  check('all keys present', ['speed','pitch','comment','colorTag','sectionLabel','clipCut','sameTitle','order','annotateDifferent'].every(k => k in n));
  check('annotateDifferent default true', n.annotateDifferent === true);
  check('sameTitle default A', n.sameTitle === 'A');
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

console.log('Test: annotateDifferent=false suppresses differing-clip notes');
{
  const a = [pc({ clipId: 'cA', songId: 's1', comment: 'A-note' })];
  const b = [pc({ clipId: 'cB', songId: 's1', comment: 'B-note' })];

  // clipCut=A, annotations off: keep A's clip + comment, no [B 中的片段不同]
  const offA = buildMergeRows(a, b, { annotateDifferent: false }).rows[0];
  check('off clipCut=A keeps A clip', offA.clipId === 'cA');
  check('off clipCut=A comment unchanged', offA.comment === 'A-note');
  check('off clipCut=A no diff note', !offA.comment.includes('[B 中的片段不同]'));
  check('off still counts markedDifferent', buildMergeRows(a, b, { annotateDifferent: false }).summary.markedDifferent === 1);

  // clipCut=B, annotations off: no [已采用 B 的片段]
  const offB = buildMergeRows(a, b, { annotateDifferent: false, clipCut: 'B', comment: 'A' }).rows[0];
  check('off clipCut=B uses B clip', offB.clipId === 'cB');
  check('off clipCut=B comment unchanged', offB.comment === 'A-note');
  check('off clipCut=B no adopted note', !offB.comment.includes('[已采用 B 的片段]'));

  // multiple differing B clips of same song, annotations off: no [B 中存在多个不同片段]
  const a2 = [pc({ clipId: 'cA', songId: 's1', comment: null })];
  const b2 = [
    pc({ clipId: 'cB1', songId: 's1' }),
    pc({ clipId: 'cB2', songId: 's1' }),
  ];
  const offMulti = buildMergeRows(a2, b2, { annotateDifferent: false }).rows[0];
  check('off no multiple-different note', offMulti.comment === null);

  // deleted-song note ([此歌已删]) must still appear even when annotations off
  const a3 = [pc({ clipId: 'gone', songId: 's9', comment: 'x' })];
  const b3 = [pc({ clipId: 'nb', songId: 's8' })];
  const offDel = buildMergeRows(a3, b3, { annotateDifferent: false });
  const goneRow = offDel.rows.find(r => r.clipId === 'gone');
  check('off deleted note still present', goneRow.comment.includes('[此歌已删]'));
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
  check('summary', JSON.stringify(omitted.summary) === JSON.stringify({ added: 1, merged: 1, markedDifferent: 1, markedDeleted: 1, markedExtra: 0 }));
}

console.log('Test: sameTitle (a song only A has vs a different song only B has, same title)');
{
  const seq = (r) => r.rows.map((x) => x.clipId).join(',');
  const byClip = (r) => Object.fromEntries(r.rows.map((x) => [x.clipId, x]));
  // A: 秘密 by one singer (x) + a shared song (k). B: k, 秘密 by another singer (y), a new song (n).
  const a = [
    pc({ clipId: 'x', songId: 's1', title: '秘密', speed: 1.1, pitch: 2, colorTag: '#E8655A', comment: 'A-note', sectionLabel: 'aSec' }),
    pc({ clipId: 'k', songId: 'sK', title: 'K' }),
  ];
  const b = [
    pc({ clipId: 'k', songId: 'sK', title: 'K' }),
    pc({ clipId: 'y', songId: 's2', title: '秘密', speed: 0.9, pitch: -1, comment: 'B-note' }),
    pc({ clipId: 'n', songId: 's3', title: 'N' }),
  ];

  // A (default), B-order: A's 秘密 takes B's slot, unchanged; B's goes last, flagged
  const dA = buildMergeRows(a, b);
  check('A/B-order seq', seq(dA) === 'k,x,n,y');
  const x = byClip(dA).x;
  check('A kept with its own settings', x.speed === 1.1 && x.pitch === 2 && x.colorTag === '#E8655A' && x.comment === 'A-note' && x.sectionLabel === 'aSec');
  check('B one flagged extra', byClip(dA).y.comment === 'B-note\n[此歌多余]' && byClip(dA).y.speed === 0.9);
  check('A summary', JSON.stringify(dA.summary) === JSON.stringify({ added: 1, merged: 1, markedDifferent: 0, markedDeleted: 0, markedExtra: 1 }));

  // A, A-order: A's 秘密 stays where it is in A
  check('A/A-order seq', seq(buildMergeRows(a, b, { order: 'A' })) === 'x,k,n,y');

  // B: B's 秘密 is added as before; A's goes last as [此歌多余] (not [此歌已删])
  const dB = buildMergeRows(a, b, { sameTitle: 'B' });
  check('B/B-order seq', seq(dB) === 'k,y,n,x');
  check('B one kept unchanged', byClip(dB).y.comment === 'B-note' && byClip(dB).y.speed === 0.9);
  check('A one flagged extra, not deleted', byClip(dB).x.comment === 'A-note\n[此歌多余]');
  check('B summary', JSON.stringify(dB.summary) === JSON.stringify({ added: 2, merged: 1, markedDifferent: 0, markedDeleted: 0, markedExtra: 1 }));
  check('B/A-order seq', seq(buildMergeRows(a, b, { sameTitle: 'B', order: 'A' })) === 'k,y,n,x');

  // the [此歌多余] note does not depend on annotateDifferent
  check('extra note with annotations off', byClip(buildMergeRows(a, b, { annotateDifferent: false })).y.comment.includes('[此歌多余]'));
}
{
  const seq = (r) => r.rows.map((x) => x.clipId).join(',');
  // several clips and several songs under one title: the whole title moves together
  const a = [
    pc({ clipId: 'x1', songId: 's1', title: 'T' }),
    pc({ clipId: 'm', songId: 'sM', title: 'M' }),
    pc({ clipId: 'x2', songId: 's1', title: 'T' }),
    pc({ clipId: 'z', songId: 's5', title: 'T' }),
  ];
  const b = [
    pc({ clipId: 'y1', songId: 's2', title: 'T' }),
    pc({ clipId: 'm', songId: 'sM', title: 'M' }),
    pc({ clipId: 'y2', songId: 's2', title: 'T' }),
  ];
  check('group A/B-order', seq(buildMergeRows(a, b)) === 'x1,x2,z,m,y1,y2');
  check('group A/A-order', seq(buildMergeRows(a, b, { order: 'A' })) === 'x1,m,x2,z,y1,y2');
  check('group B', seq(buildMergeRows(a, b, { sameTitle: 'B' })) === 'y1,m,y2,x1,x2,z');
}
{
  const seq = (r) => r.rows.map((x) => x.clipId).join(',');
  // the same song on both sides is not a clash: B's other 秘密 is simply new
  const a = [pc({ clipId: 'x', songId: 's1', title: '秘密' })];
  const b = [pc({ clipId: 'x', songId: 's1', title: '秘密' }), pc({ clipId: 'y', songId: 's2', title: '秘密' })];
  const r = buildMergeRows(a, b);
  check('shared song: no clash', seq(r) === 'x,y' && r.summary.markedExtra === 0 && r.summary.added === 1);

  // same song, different clips: still the clipCut rule
  const r2 = buildMergeRows([pc({ clipId: 'cA', songId: 's1', title: 'T' })], [pc({ clipId: 'cB', songId: 's1', title: 'T' })]);
  check('same song other clip: clipCut rule', seq(r2) === 'cA' && r2.rows[0].comment === '[B 中的片段不同]' && r2.summary.markedExtra === 0);

  // titles must be exactly the same
  const r3 = buildMergeRows([pc({ clipId: 'x', songId: 's1', title: '秘密' })], [pc({ clipId: 'y', songId: 's2', title: '秘密 (Live)' })]);
  check('different title: old rules', seq(r3) === 'y,x' && r3.rows[1].comment === '[此歌已删]' && r3.summary.markedExtra === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
