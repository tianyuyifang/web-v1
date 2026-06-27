# Configurable Merge Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users control, per merge, which playlist (A baseline / B source) wins for each field — speed, pitch, comment, colorTag, sectionLabel, which clip cut, and clip order — via a global `MergeOptions` object, with defaults that reproduce today's behavior.

**Architecture:** A 7-field `MergeOptions` object flows UI → API → `buildMergeRows`. The pure function `buildMergeRows(aClips, bClips, options)` resolves each row's fields via the options, and separates row resolution from row ordering so A-order and B-order share identical resolution logic. Zod validates options at the route; defaults fill anything missing so old callers keep working.

**Tech Stack:** Express.js, Zod, Prisma (backend); Next.js App Router, React, Tailwind (frontend). Plain-Node test scripts in `backend/tests/` (run with `node tests/<file>.js`), following the existing `compare-dedup-test.js` style.

## Global Constraints

- `MergeOptions` fields and defaults (exact): `speed:"B"`, `pitch:"A"`, `comment:"A"`, `colorTag:"combine"`, `sectionLabel:"B"`, `clipCut:"A"`, `order:"B"`.
- Enum values: speed/pitch/sectionLabel/clipCut/order ∈ `{"A","B"}`; comment/colorTag ∈ `{"A","B","combine"}`.
- Annotation constants (verbatim, Chinese): different clip kept = `[B 中的片段不同]`; multiple different = `[B 中存在多个不同片段]`; deleted = `[此歌已删]`; clip swapped to B = `[已采用 B 的片段]`.
- Defaults MUST reproduce current merge output exactly when options are omitted.
- New playlist name stays `更新版 {A.name}`.
- Summary counters (`added/merged/markedDifferent/markedDeleted`) are independent of `order`.
- Backend tests run via `node tests/<file>.js` from `backend/`, exit code 0 = pass.
- Frontend i18n keys must be added to BOTH `src/i18n/en.js` and `src/i18n/zh.js`.

---

## File Structure

- `backend/src/services/mergeService.js` — MODIFY. Add options handling, `pick`/`combineComment` helpers, new annotation constant, `clipCut`/`order` branches; thread options through `mergePlaylists`.
- `backend/tests/merge-options-test.js` — CREATE. Unit tests for `buildMergeRows` with options.
- `backend/src/validators/playlists.js` — MODIFY. Add `mergeOptionsSchema`, attach to `mergePlaylistSchema`.
- `backend/src/routes/playlists.js` — MODIFY. Pass `req.validated.options` into `mergePlaylists`.
- `frontend/src/lib/api.js` — MODIFY. `merge(aId, bId, options)`.
- `frontend/src/components/tools/MergeOptions.js` — CREATE. The 7-dropdown panel.
- `frontend/src/app/tools/merge/page.js` — MODIFY. Render panel, pass options to API.
- `frontend/src/i18n/en.js`, `frontend/src/i18n/zh.js` — MODIFY. New keys.

---

## Task 1: Merge options resolution helpers + Rule 4 (matched clips)

**Files:**
- Modify: `backend/src/services/mergeService.js`
- Test: `backend/tests/merge-options-test.js`

**Interfaces:**
- Consumes: existing `buildMergeRows(aClips, bClips)`, `unionColorTags(a, b)`, `appendAnnotation(existing, annotation)`.
- Produces:
  - `DEFAULT_MERGE_OPTIONS` — frozen object with the 7 defaults.
  - `normalizeOptions(options)` → full options object (missing fields → defaults).
  - `pick(opt, aVal, bVal, combiner)` → `opt==="A"?aVal : opt==="B"?bVal : combiner(aVal,bVal)`.
  - `combineComment(a, b)` → string|null (A then B, newline-joined, empties skipped, exact-duplicate line not doubled).
  - `buildMergeRows(aClips, bClips, options)` — third arg added; defaults applied via `normalizeOptions`.

- [ ] **Step 1: Write failing tests for helpers + Rule 4 field resolution**

Create `backend/tests/merge-options-test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node tests/merge-options-test.js`
Expected: FAIL — `normalizeOptions`/`pick`/`combineComment` are `undefined` (TypeError), or Rule-4 assertions fail because options aren't honored yet.

- [ ] **Step 3: Add constants + helpers near the top of `mergeService.js`**

After the existing annotation constants (after `const ANNOTATION_DELETED = '[此歌已删]';`), add:

```js
const ANNOTATION_CLIP_FROM_B = '[已采用 B 的片段]';

const DEFAULT_MERGE_OPTIONS = Object.freeze({
  speed: 'B',
  pitch: 'A',
  comment: 'A',
  colorTag: 'combine',
  sectionLabel: 'B',
  clipCut: 'A',
  order: 'B',
});

function normalizeOptions(options) {
  return { ...DEFAULT_MERGE_OPTIONS, ...(options || {}) };
}

function pick(opt, aVal, bVal, combiner) {
  if (opt === 'A') return aVal;
  if (opt === 'B') return bVal;
  return combiner ? combiner(aVal, bVal) : bVal;
}

function combineComment(a, b) {
  const lines = [];
  for (const v of [a, b]) {
    if (v === null || v === undefined || v === '') continue;
    if (!lines.includes(v)) lines.push(v);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}
```

- [ ] **Step 4: Thread options into `buildMergeRows` and apply to Rule 4**

Change the signature:

```js
function buildMergeRows(aClips, bClips, options) {
  const opts = normalizeOptions(options);
```

Replace the Rule 4 block (the `if (aByExactClip && !consumedA.has(aByExactClip.clipId))` body) with:

```js
    // Rule 4: same clip.id in both
    if (aByExactClip && !consumedA.has(aByExactClip.clipId)) {
      rows.push({
        clipId: aByExactClip.clipId,
        speed: pick(opts.speed, aByExactClip.speed, bPc.speed),
        pitch: pick(opts.pitch, aByExactClip.pitch, bPc.pitch),
        colorTag: pick(opts.colorTag, aByExactClip.colorTag, bPc.colorTag, unionColorTags),
        comment: pick(opts.comment, aByExactClip.comment, bPc.comment, combineComment),
        sectionLabel: pick(opts.sectionLabel, aByExactClip.sectionLabel, bPc.sectionLabel),
      });
      consumedA.add(aByExactClip.clipId);
      merged++;
      continue;
    }
```

Add the new symbols to `module.exports`:

```js
module.exports = {
  mergePlaylists, buildMergeRows, unionColorTags, appendAnnotation,
  DEFAULT_MERGE_OPTIONS, normalizeOptions, pick, combineComment,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && node tests/merge-options-test.js`
Expected: PASS (all assertions).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/mergeService.js backend/tests/merge-options-test.js
git commit -m "feat(merge): options helpers + configurable Rule 4 field resolution"
```

---

## Task 2: clipCut option on Rule 2 (same song, different clip)

**Files:**
- Modify: `backend/src/services/mergeService.js`
- Test: `backend/tests/merge-options-test.js`

**Interfaces:**
- Consumes: `pick`, `combineComment`, `appendAnnotation`, `ANNOTATION_DIFFERENT_CLIP`, `ANNOTATION_CLIP_FROM_B`, `normalizeOptions` (from Task 1).
- Produces: Rule 2 branches on `opts.clipCut`. `clipCut==="A"` keeps today's behavior. `clipCut==="B"` emits B's clipId with options-resolved fields + `[已采用 B 的片段]` appended after the resolved comment; A clip marked consumed.

- [ ] **Step 1: Add failing tests for clipCut**

Append to `backend/tests/merge-options-test.js` before the final summary lines:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node tests/merge-options-test.js`
Expected: FAIL on the clipCut=B assertions (still keeps A clip, no `[已采用 B 的片段]`).

- [ ] **Step 3: Branch Rule 2 on clipCut**

Replace the Rule 2 "first encounter" block — the part starting at `const aPick = aMatches.find((aPc) => !consumedA.has(aPc.clipId));` through `markedDifferent++;` — with:

```js
    // First encounter for this songId in B with different clip.id.
    const aPick = aMatches.find((aPc) => !consumedA.has(aPc.clipId));
    if (!aPick) {
      // All A clips of this song already consumed. Skip.
      continue;
    }

    if (opts.clipCut === 'B') {
      // Adopt B's clip cut; resolve fields via options against the matched A clip,
      // then annotate that the cut was swapped to B's.
      const resolvedComment = pick(opts.comment, aPick.comment, bPc.comment, combineComment);
      rows.push({
        clipId: bPc.clipId,
        speed: pick(opts.speed, aPick.speed, bPc.speed),
        pitch: pick(opts.pitch, aPick.pitch, bPc.pitch),
        colorTag: pick(opts.colorTag, aPick.colorTag, bPc.colorTag, unionColorTags),
        comment: appendAnnotation(resolvedComment, ANNOTATION_CLIP_FROM_B),
        sectionLabel: pick(opts.sectionLabel, aPick.sectionLabel, bPc.sectionLabel),
      });
      consumedA.add(aPick.clipId);
      markedDifferent++;
      continue;
    }

    // clipCut === 'A' (default): keep A's clip, flag it.
    const newComment = appendAnnotation(aPick.comment, ANNOTATION_DIFFERENT_CLIP);
    rows.push({
      clipId: aPick.clipId,
      speed: aPick.speed,
      pitch: aPick.pitch,
      colorTag: aPick.colorTag,
      comment: newComment,
      sectionLabel: aPick.sectionLabel,
    });
    consumedA.add(aPick.clipId);
    rule2FirstIndexBySong.set(sid, rows.length - 1);
    markedDifferent++;
```

Note: the `rule2FirstIndexBySong` "multiple different" handling at the top of the loop only applies to `clipCut="A"` rows. When `clipCut="B"`, `rule2FirstIndexBySong` is never set for that song, so subsequent B clips of the same song that have a still-unconsumed A clip will also adopt B (each emitting its own B row); if no unconsumed A clip remains, they fall through the `if (!aPick) continue;` guard. This is acceptable and consistent.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node tests/merge-options-test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mergeService.js backend/tests/merge-options-test.js
git commit -m "feat(merge): clipCut option adopts B's clip with [已采用 B 的片段]"
```

---

## Task 3: order option (A-order vs B-order emission)

**Files:**
- Modify: `backend/src/services/mergeService.js`
- Test: `backend/tests/merge-options-test.js`

**Interfaces:**
- Consumes: the resolved-rows logic from Tasks 1–2.
- Produces: `buildMergeRows` emits rows in A's order when `opts.order==="A"`, B's order when `"B"`. Summary counters unchanged by order. Each pushed row internally tags its provenance so A-order can re-sequence; provenance is stripped from the returned `rows`.

**Approach:** Today rows are pushed in B-walk order, with Rule 5 leftovers appended. To support A-order without duplicating resolution logic, tag each row with a non-enumerated provenance marker as it's built, then reorder at the end for `order==="A"`.

- [ ] **Step 1: Add failing tests for order**

Append to `backend/tests/merge-options-test.js` before the summary lines:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node tests/merge-options-test.js`
Expected: FAIL — A-order sequence assertion fails (rows still in B-order), and/or provenance-leak check fails once markers are added but not stripped.

- [ ] **Step 3: Tag provenance, then reorder for order="A"**

Tag rows as they are built. In every `rows.push({...})` inside the B-walk loop (Rule 1, Rule 4, both Rule 2 branches), add a provenance field:
- Rule 1 (added): `__src: 'B', __bPos: <index of bPc in bClips>`
- Rule 4 and Rule 2 (both branches): `__src: 'A', __aClipId: <the A clip's clipId>` (use `aByExactClip.clipId` for Rule 4, `aPick.clipId` for Rule 2)

The simplest reliable way to get `__bPos` and A clip identity: the B-walk already iterates `bClips`; change it to `for (let bi = 0; bi < bClips.length; bi++) { const bPc = bClips[bi]; ... }` so `bi` is available. For added rows set `__bPos: bi`. For A-sourced rows set `__aClipId` to the consumed A clip's id.

In the Rule 5 leftover loop, tag: `__src: 'A', __aClipId: aPc.clipId`.

Then, just before `return`, build the final ordered+cleaned array:

```js
  const stripProvenance = (r) => {
    const { __src, __bPos, __aClipId, ...clean } = r;
    return clean;
  };

  let ordered;
  if (opts.order === 'A') {
    // A's order first (every row whose __aClipId matches an A clip, in A's sequence),
    // then rows sourced purely from B (added), in B's order.
    const byAClipId = new Map();
    for (const r of rows) {
      if (r.__src === 'A' && r.__aClipId != null) byAClipId.set(r.__aClipId, r);
    }
    const aSeq = [];
    for (const aPc of aClips) {
      const r = byAClipId.get(aPc.clipId);
      if (r) aSeq.push(r);
    }
    const bAdded = rows
      .filter((r) => r.__src === 'B')
      .sort((x, y) => x.__bPos - y.__bPos);
    ordered = [...aSeq, ...bAdded];
  } else {
    ordered = rows; // B-walk order already correct (Rule 5 appended last)
  }

  return {
    rows: ordered.map(stripProvenance),
    summary: { added, merged, markedDifferent, markedDeleted },
  };
```

Remove the old `return { rows, summary: {...} };` at the end of the function (replaced by the block above).

Note: for `order="A"`, each A clip appears at most once in `byAClipId` (a clip id is unique within A), and only A-sourced rows carry `__aClipId`, so Rule-1 added rows are excluded from `aSeq` and correctly land in `bAdded`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node tests/merge-options-test.js`
Expected: PASS (all order assertions + no provenance leak).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mergeService.js backend/tests/merge-options-test.js
git commit -m "feat(merge): order option for A-order vs B-order emission"
```

---

## Task 4: Regression guard — defaults reproduce today's behavior

**Files:**
- Test: `backend/tests/merge-options-test.js`

**Interfaces:**
- Consumes: `buildMergeRows` (final form).
- Produces: a test proving omitted options == explicit defaults == documented legacy behavior across all rules.

- [ ] **Step 1: Add the regression test**

Append to `backend/tests/merge-options-test.js` before the summary lines:

```js
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
```

- [ ] **Step 2: Run test**

Run: `cd backend && node tests/merge-options-test.js`
Expected: PASS. If any legacy assertion fails, the refactor changed behavior — fix `mergeService.js`, do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/merge-options-test.js
git commit -m "test(merge): regression guard that defaults reproduce legacy behavior"
```

---

## Task 5: Validate options at the route (Zod) + thread through service

**Files:**
- Modify: `backend/src/validators/playlists.js`
- Modify: `backend/src/routes/playlists.js:332-339`
- Modify: `backend/src/services/mergeService.js` (signature only)

**Interfaces:**
- Consumes: `mergePlaylistSchema` (existing), `mergeService.mergePlaylists`.
- Produces: `mergePlaylistSchema` accepts optional `options`; `mergePlaylists(callerId, aId, bId, options)`; route passes `req.validated.options`.

- [ ] **Step 1: Add `mergeOptionsSchema` and attach to merge schema**

In `backend/src/validators/playlists.js`, replace the `mergePlaylistSchema` block with:

```js
const AB = z.enum(['A', 'B']);
const ABC = z.enum(['A', 'B', 'combine']);

const mergeOptionsSchema = z.object({
  speed: AB.optional(),
  pitch: AB.optional(),
  comment: ABC.optional(),
  colorTag: ABC.optional(),
  sectionLabel: AB.optional(),
  clipCut: AB.optional(),
  order: AB.optional(),
}).optional();

const mergePlaylistSchema = z.object({
  aId: z.string().uuid(),
  bId: z.string().uuid(),
  options: mergeOptionsSchema,
}).refine((d) => d.aId !== d.bId, {
  message: 'aId and bId must differ',
});
```

Add `mergeOptionsSchema` to `module.exports`.

- [ ] **Step 2: Update the route handler**

In `backend/src/routes/playlists.js`, the merge route (around line 333):

```js
router.post('/merge', validate(mergePlaylistSchema), async (req, res, next) => {
  try {
    const { aId, bId, options } = req.validated;
    const result = await mergeService.mergePlaylists(req.user.id, aId, bId, options);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Update `mergePlaylists` signature to accept + forward options**

In `backend/src/services/mergeService.js`, change:

```js
async function mergePlaylists(callerId, aId, bId, options) {
```

and the `buildMergeRows` call:

```js
  const { rows, summary } = buildMergeRows(aClips, bClips, options);
```

- [ ] **Step 4: Manual validation check (backend running)**

Start backend: `cd backend && npm run dev` (separate shell). Then:

```bash
# invalid enum -> expect 400
curl -s -X POST http://localhost:4000/api/playlists/merge \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"aId":"<uuidA>","bId":"<uuidB>","options":{"speed":"C"}}' -w "\n[%{http_code}]\n"
```

Expected: `[400]` with a validation error message. (Use real owned-A / viewable-B UUIDs and a valid token; omitting `options` entirely must still succeed as before.)

- [ ] **Step 5: Run the merge unit tests again (no regression)**

Run: `cd backend && node tests/merge-options-test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/validators/playlists.js backend/src/routes/playlists.js backend/src/services/mergeService.js
git commit -m "feat(merge): validate options via Zod and thread through service"
```

---

## Task 6: Frontend API client — pass options

**Files:**
- Modify: `frontend/src/lib/api.js` (the `merge` entry in `playlistsAPI`)

**Interfaces:**
- Consumes: existing axios `api` instance.
- Produces: `playlistsAPI.merge(aId, bId, options)` → `POST /api/playlists/merge` body `{ aId, bId, options }`.

- [ ] **Step 1: Update the merge method**

In `frontend/src/lib/api.js`, change:

```js
  merge: (aId, bId, options) => api.post(`/playlists/merge`, { aId, bId, options }),
```

(When `options` is `undefined`, axios omits it from the JSON body, so the backend applies defaults — back-compatible.)

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/api.js
git commit -m "feat(merge): api client passes merge options"
```

---

## Task 7: MergeOptions panel component

**Files:**
- Create: `frontend/src/components/tools/MergeOptions.js`

**Interfaces:**
- Consumes: `useLanguage` (`t`), `DEFAULT_MERGE_OPTIONS` values (mirrored client-side).
- Produces: default export `MergeOptions({ value, onChange, aName, bName })`. `value` is the current options object; `onChange(nextOptions)` fires on any dropdown change. Renders 7 labeled selects.

- [ ] **Step 1: Create the component**

Create `frontend/src/components/tools/MergeOptions.js`:

```jsx
"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

export const DEFAULT_MERGE_OPTIONS = {
  speed: "B",
  pitch: "A",
  comment: "A",
  colorTag: "combine",
  sectionLabel: "B",
  clipCut: "A",
  order: "B",
};

// field key -> whether it supports "combine"
const FIELDS = [
  { key: "speed", combine: false },
  { key: "pitch", combine: false },
  { key: "comment", combine: true },
  { key: "colorTag", combine: true },
  { key: "sectionLabel", combine: false },
  { key: "clipCut", combine: false },
  { key: "order", combine: false },
];

export default function MergeOptions({ value, onChange, aName, bName }) {
  const { t } = useLanguage();
  const opts = { ...DEFAULT_MERGE_OPTIONS, ...(value || {}) };

  const set = (key, v) => onChange({ ...opts, [key]: v });

  const aLabel = `A${aName ? ` (${aName})` : ""}`;
  const bLabel = `B${bName ? ` (${bName})` : ""}`;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-3">
      <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>
        {t("mergeOptionsTitle")}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FIELDS.map(({ key, combine }) => (
          <label key={key} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted">{t(`mergeOpt_${key}`)}</span>
            <select
              value={opts[key]}
              onChange={(e) => set(key, e.target.value)}
              className="rounded border border-border bg-surface px-2 py-1 text-sm"
              style={{ color: "var(--text)" }}
            >
              <option value="A">{aLabel}</option>
              <option value="B">{bLabel}</option>
              {combine && <option value="combine">{t("mergeOpt_combine")}</option>}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/tools/MergeOptions.js
git commit -m "feat(merge): MergeOptions dropdown panel component"
```

---

## Task 8: Wire panel into the merge page

**Files:**
- Modify: `frontend/src/app/tools/merge/page.js`

**Interfaces:**
- Consumes: `MergeOptions`, `DEFAULT_MERGE_OPTIONS` from Task 7; `playlistsAPI.merge(aId, bId, options)` from Task 6.
- Produces: page holds `options` state, renders `<MergeOptions>` between pickers and the Merge button, passes options to the API.

- [ ] **Step 1: Import and add state**

In `frontend/src/app/tools/merge/page.js`, add the import near the existing imports:

```js
import MergeOptions, { DEFAULT_MERGE_OPTIONS } from "@/components/tools/MergeOptions";
```

Add state alongside the other `useState` calls:

```js
  const [options, setOptions] = useState(DEFAULT_MERGE_OPTIONS);
```

- [ ] **Step 2: Pass options to the API in `handleConfirm`**

Change the merge call:

```js
      const res = await playlistsAPI.merge(aPlaylist.id, bPlaylist.id, options);
```

- [ ] **Step 3: Render the panel between pickers and the Merge button**

In the JSX, after the second `<PlaylistPicker .../>` (the source picker) and before the `<div>` wrapping the Merge `<button>`, insert:

```jsx
        {aPlaylist && bPlaylist && (
          <MergeOptions
            value={options}
            onChange={setOptions}
            aName={aPlaylist.name}
            bName={bPlaylist.name}
          />
        )}
```

- [ ] **Step 4: Build to verify no errors**

Run: `cd frontend && npx cross-env NODE_OPTIONS=--no-deprecation next build 2>&1 | tail -20`
Expected: "Compiled successfully" and `/tools/merge` listed in the route table.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/tools/merge/page.js
git commit -m "feat(merge): render MergeOptions panel on merge page"
```

---

## Task 9: i18n keys (en + zh)

**Files:**
- Modify: `frontend/src/i18n/en.js`
- Modify: `frontend/src/i18n/zh.js`

**Interfaces:**
- Consumes: nothing.
- Produces: keys used by `MergeOptions`: `mergeOptionsTitle`, `mergeOpt_speed`, `mergeOpt_pitch`, `mergeOpt_comment`, `mergeOpt_colorTag`, `mergeOpt_sectionLabel`, `mergeOpt_clipCut`, `mergeOpt_order`, `mergeOpt_combine`.

- [ ] **Step 1: Add English keys**

In `frontend/src/i18n/en.js`, after the existing `mergeSuccessSummary` line, add:

```js
  mergeOptionsTitle: "Merge options",
  mergeOpt_speed: "Speed",
  mergeOpt_pitch: "Pitch",
  mergeOpt_comment: "Comment",
  mergeOpt_colorTag: "Color tag",
  mergeOpt_sectionLabel: "Section label",
  mergeOpt_clipCut: "Clip (when song differs)",
  mergeOpt_order: "Clip order",
  mergeOpt_combine: "Combine",
```

- [ ] **Step 2: Add Chinese keys**

In `frontend/src/i18n/zh.js`, after the existing `mergeSuccessSummary` line, add:

```js
  mergeOptionsTitle: "合并选项",
  mergeOpt_speed: "速度",
  mergeOpt_pitch: "音调",
  mergeOpt_comment: "备注",
  mergeOpt_colorTag: "颜色标签",
  mergeOpt_sectionLabel: "分段标签",
  mergeOpt_clipCut: "片段（同歌不同片段时）",
  mergeOpt_order: "片段顺序",
  mergeOpt_combine: "合并两者",
```

- [ ] **Step 3: Build to verify**

Run: `cd frontend && npx cross-env NODE_OPTIONS=--no-deprecation next build 2>&1 | tail -8`
Expected: "Compiled successfully".

- [ ] **Step 4: Commit**

```bash
git add frontend/src/i18n/en.js frontend/src/i18n/zh.js
git commit -m "feat(merge): i18n keys for merge options panel"
```

---

## Task 10: End-to-end live verification

**Files:** none (verification only).

- [ ] **Step 1: Start both servers**

`cd backend && npm run dev` and `cd frontend && npm run dev` (separate shells).

- [ ] **Step 2: Drive the UI**

As a user who owns playlist A and can view playlist B:
1. Go to `/tools/merge`, pick A and B → the MergeOptions panel appears.
2. Change `Clip order` to A and `Clip (when song differs)` to B; Merge.
3. On the resulting `更新版 {A}` playlist, confirm: order follows A then new-B songs at bottom; a song where A/B had different cuts shows B's clip with `[已采用 B 的片段]` in its comment.

- [ ] **Step 3: Verify defaults path unchanged**

Merge again leaving all options at defaults → result matches pre-feature merge behavior (B-order, A-only at bottom flagged `[此歌已删]`, etc.).

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(merge): verification fixups"
```

(Skip if nothing changed.)

---

## Self-Review Notes

- **Spec coverage:** speed/pitch/comment/colorTag/sectionLabel → Task 1; clipCut (`[已采用 B 的片段]`) → Task 2; order → Task 3; defaults-reproduce-legacy → Task 4; Zod validation + service threading → Task 5; API client → Task 6; panel → Task 7; page wiring → Task 8; i18n → Task 9; live verify → Task 10. All spec sections covered.
- **Type consistency:** `buildMergeRows(aClips, bClips, options)`, `mergePlaylists(callerId, aId, bId, options)`, `pick(opt, aVal, bVal, combiner)`, `combineComment(a, b)`, `normalizeOptions(options)`, `DEFAULT_MERGE_OPTIONS` used consistently across tasks. Client mirror `DEFAULT_MERGE_OPTIONS` lives in `MergeOptions.js` and is imported by the page.
- **No placeholders:** every code step shows full code; commands have expected output.
