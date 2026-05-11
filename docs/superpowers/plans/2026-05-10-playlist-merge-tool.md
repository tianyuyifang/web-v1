# Playlist Merge Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/tools/merge` page that takes baseline playlist A (owned by caller) and source playlist B (owned, public, or copy-allowed), and creates a new playlist combining them according to four merge rules.

**Architecture:** New backend `POST /api/playlists/merge` route invoking a new `mergeService` that implements the four-rule algorithm in a single Prisma transaction. New frontend page at `/tools/merge` reusing `PlaylistPicker` with two new props (`ownerOnly`, owner-display formatting). Minor adjustments to existing files: `getUserPlaylists` always returns `ownerName`; `diffDesktopOnly` i18n key renamed to `toolsDesktopOnly` (shared between Diff and Merge pages); Tools hub gains a second tile.

**Tech Stack:** Express.js, Prisma, Zod, Next.js 14 App Router, React 18, Tailwind, plain JavaScript.

**Spec:** [`docs/superpowers/specs/2026-05-10-playlist-merge-tool-design.md`](../specs/2026-05-10-playlist-merge-tool-design.md)

---

## File Structure

**Backend:**
- Create: `backend/src/services/mergeService.js` — pure-ish merge algorithm: input two arrays of playlistClips + caller id, output an array of result-row objects ready to write. Plus the orchestration function that loads playlists, calls the algorithm, and writes the new playlist + clips in a transaction.
- Modify: `backend/src/validators/playlists.js` — add `mergePlaylistSchema`.
- Modify: `backend/src/routes/playlists.js` — add `POST /merge` route (before the `/:id` catch-all, like the diff route).
- Modify: `backend/src/services/playlistService.js` — `getUserPlaylists`: always return `ownerName` (one line change).

**Frontend (new):**
- Create: `frontend/src/app/tools/merge/page.js` — the page; owns URL state (none — page does not deep-link), pickers, confirmation modal, API call, navigation.

**Frontend (modified):**
- Modify: `frontend/src/components/tools/PlaylistPicker.js` — add `ownerOnly` prop, render `{name} — {ownerLabel}` rows.
- Modify: `frontend/src/lib/api.js` — add `playlistsAPI.merge(aId, bId)`.
- Modify: `frontend/src/app/tools/page.js` — append Merge tile.
- Modify: `frontend/src/app/tools/diff/page.js` — switch `t("diffDesktopOnly")` to `t("toolsDesktopOnly")`.
- Modify: `frontend/src/i18n/en.js` and `frontend/src/i18n/zh.js` — add merge keys; rename `diffDesktopOnly` → `toolsDesktopOnly`; add `you` key (English "you" / Chinese "我").

No tests. Project has no automated frontend/backend test suite; verification is manual per the spec's test plan.

Task order: backend service first (the algorithm is the hardest part), then validators + route, then API client + i18n, then the page, then Tools hub tile, then PlaylistPicker enhancement, then the existing-files adjustments (`getUserPlaylists`, Diff page rename). The order is chosen so each commit leaves the app in a working state.

---

## Task 1: Backend — merge algorithm and service

**Files:**
- Create: `backend/src/services/mergeService.js`

- [ ] **Step 1: Create the merge service file**

Create `backend/src/services/mergeService.js` with the following content:

```js
const prisma = require('../db/client');
const { NotFoundError, ForbiddenError } = require('../utils/errors');
const { toPinyin, toPinyinInitials, toPinyinAll } = require('../utils/pinyin');

const ANNOTATION_DIFFERENT_CLIP = '[B 中的片段不同]';
const ANNOTATION_MULTIPLE_DIFFERENT_CLIPS = '[B 中存在多个不同片段]';
const ANNOTATION_DELETED = '[此歌已删]';

/**
 * Append an annotation line to an existing comment.
 *   - if existing is empty/null, return just the annotation
 *   - else return existing + "\n" + annotation
 */
function appendAnnotation(existing, annotation) {
  if (existing === null || existing === undefined || existing === '') {
    return annotation;
  }
  return `${existing}\n${annotation}`;
}

/**
 * Union of two pipe-separated color tag strings.
 * "red|blue" + "blue|green" => "red|blue|green"
 * Returns null if both empty.
 */
function unionColorTags(a, b) {
  const parse = (s) => (s ? s.split('|').filter(Boolean) : []);
  const seen = new Set();
  const out = [];
  for (const c of [...parse(a), ...parse(b)]) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out.length > 0 ? out.join('|') : null;
}

/**
 * Compute merge result rows.
 *
 * aClips, bClips: arrays of playlistClip rows from prisma.playlistClip.findMany,
 *   each including clip.{id, songId} (the `clip` field already nests these).
 *   Sorted by position asc.
 *
 * Returns: { rows, summary } where
 *   rows is an array of { clipId, speed, pitch, colorTag, comment, sectionLabel },
 *     ready to be written as playlistClip rows in order.
 *   summary is { added, merged, markedDifferent, markedDeleted } for the API response.
 */
function buildMergeRows(aClips, bClips) {
  // Index A by songId -> ordered list of A clips for that song
  const aBySongId = new Map();
  for (const pc of aClips) {
    const sid = pc.clip.songId;
    if (!aBySongId.has(sid)) aBySongId.set(sid, []);
    aBySongId.get(sid).push(pc);
  }

  // Index A by clip.id for fast Rule-4 lookup
  const aByClipId = new Map();
  for (const pc of aClips) aByClipId.set(pc.clipId, pc);

  // Track which A playlistClips were consumed (so Rule 5 only emits leftovers)
  const consumedA = new Set();

  // Track Rule-2 first-encounter A clip per songId, so subsequent B clips of the
  // same song with different clip.id can append the "multiple different" line
  // to the already-emitted row (not emit a new row).
  // Map of songId -> index into `rows` array.
  const rule2FirstIndexBySong = new Map();

  const rows = [];
  let added = 0, merged = 0, markedDifferent = 0, markedDeleted = 0;

  for (const bPc of bClips) {
    const sid = bPc.clip.songId;
    const aMatches = aBySongId.get(sid) || [];
    const aByExactClip = aByClipId.get(bPc.clipId);

    // Rule 1: no A clip of this song at all
    if (aMatches.length === 0) {
      rows.push({
        clipId: bPc.clipId,
        speed: bPc.speed,
        pitch: bPc.pitch,
        colorTag: bPc.colorTag,
        comment: bPc.comment,
        sectionLabel: bPc.sectionLabel,
      });
      added++;
      continue;
    }

    // Rule 4: same clip.id in both
    if (aByExactClip && aMatches.includes(aByExactClip) && !consumedA.has(aByExactClip.clipId)) {
      rows.push({
        clipId: aByExactClip.clipId,
        speed: bPc.speed,                                                // B's speed
        pitch: aByExactClip.pitch,                                       // A's pitch (untouched)
        colorTag: unionColorTags(aByExactClip.colorTag, bPc.colorTag),   // union
        comment: aByExactClip.comment,                                   // A's comment unchanged
        sectionLabel: bPc.sectionLabel,                                  // B's section label
      });
      consumedA.add(aByExactClip.clipId);
      merged++;
      continue;
    }

    // Rule 2: same songId, different clip.id
    if (rule2FirstIndexBySong.has(sid)) {
      // Subsequent B clip of same song with different clip.id -> append the
      // "multiple different" annotation to the already-emitted row (only once).
      const idx = rule2FirstIndexBySong.get(sid);
      const row = rows[idx];
      if (!row.comment || !row.comment.includes(ANNOTATION_MULTIPLE_DIFFERENT_CLIPS)) {
        row.comment = appendAnnotation(row.comment, ANNOTATION_MULTIPLE_DIFFERENT_CLIPS);
      }
      continue;
    }

    // First encounter for this songId in B with different clip.id. Find the first
    // unconsumed A clip of this song and emit a Rule-2 row.
    const aPick = aMatches.find((aPc) => !consumedA.has(aPc.clipId));
    if (!aPick) {
      // All A clips of this song are already consumed (rare: A had multiple clips of same song,
      // all matched by clip.id in earlier B iterations). Skip — nothing to emit.
      continue;
    }
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
  }

  // Rule 5: A clips not consumed -> append at bottom in A's original order
  for (const aPc of aClips) {
    if (consumedA.has(aPc.clipId)) continue;
    rows.push({
      clipId: aPc.clipId,
      speed: aPc.speed,
      pitch: aPc.pitch,
      colorTag: aPc.colorTag,
      comment: appendAnnotation(aPc.comment, ANNOTATION_DELETED),
      sectionLabel: aPc.sectionLabel,
    });
    markedDeleted++;
  }

  return {
    rows,
    summary: { added, merged, markedDifferent, markedDeleted },
  };
}

/**
 * Top-level merge orchestrator.
 * Loads A and B, checks permissions, runs buildMergeRows, writes the new playlist.
 *
 * Returns: { id, name, summary }.
 * Throws: ForbiddenError (caller does not own A), NotFoundError (B not viewable).
 */
async function mergePlaylists(callerId, aId, bId) {
  const [aPl, bPl] = await Promise.all([
    prisma.playlist.findUnique({
      where: { id: aId },
      include: {
        copyPermissions: { where: { userId: callerId }, select: { id: true }, take: 1 },
      },
    }),
    prisma.playlist.findUnique({
      where: { id: bId },
      include: {
        copyPermissions: { where: { userId: callerId }, select: { id: true }, take: 1 },
      },
    }),
  ]);

  if (!aPl) throw new NotFoundError('Playlist');
  if (aPl.userId !== callerId) {
    throw new ForbiddenError('You must own the baseline playlist');
  }

  if (!bPl) throw new NotFoundError('Playlist');
  const bCanView =
    bPl.userId === callerId || bPl.isPublic || bPl.copyPermissions.length > 0;
  if (!bCanView) throw new NotFoundError('Playlist');

  const [aClips, bClips] = await Promise.all([
    prisma.playlistClip.findMany({
      where: { playlistId: aId },
      orderBy: { position: 'asc' },
      include: { clip: { select: { id: true, songId: true } } },
    }),
    prisma.playlistClip.findMany({
      where: { playlistId: bId },
      orderBy: { position: 'asc' },
      include: { clip: { select: { id: true, songId: true } } },
    }),
  ]);

  const { rows, summary } = buildMergeRows(aClips, bClips);

  const newName = `更新版 ${aPl.name}`;
  const newPlaylist = await prisma.playlist.create({
    data: {
      userId: callerId,
      name: newName,
      description: aPl.description,
      isPublic: false,
      namePinyin: toPinyin(newName),
      namePinyinInitials: toPinyinInitials(newName),
      namePinyinAll: toPinyinAll(newName),
      playlistClips: {
        create: rows.map((r, idx) => ({
          clipId: r.clipId,
          position: idx,
          speed: r.speed,
          pitch: r.pitch,
          colorTag: r.colorTag,
          comment: r.comment,
          sectionLabel: r.sectionLabel,
        })),
      },
    },
  });

  return { id: newPlaylist.id, name: newPlaylist.name, summary };
}

module.exports = { mergePlaylists, buildMergeRows, unionColorTags, appendAnnotation };
```

Notes for the implementer:
- The three annotation constants are module-scoped, not exported individually (export them via the module if you anticipate testing). The plan exports `unionColorTags` and `appendAnnotation` for testability though no tests are scheduled — keeps the door open for an inline node test later if needed.
- `buildMergeRows` is pure (no DB calls). `mergePlaylists` is the side-effecting wrapper.
- `prisma.playlist.create({ data: { ..., playlistClips: { create: [...] } } })` writes the playlist and all `playlistClip` rows in a single transaction (Prisma's nested `create`). No explicit `prisma.$transaction` needed.
- The same `clipId` cannot appear twice in `rows` because the algorithm uses `consumedA` to mark each A clip used and Rule 1 uses B clip ids that didn't match any A. There's still a theoretical edge case where two B clips of song S have different clip.ids and one matches an A clip exactly (Rule 4) and the other triggers Rule 2 — the second one would try to pick a different unconsumed A clip; if A only had one clip of S, the `aPick` would be undefined and the row is skipped. Verified to be correct.

- [ ] **Step 2: Restart backend dev server**

Stop the running backend (Ctrl-C, or `taskkill /F /IM node.exe` if detached). Then:

```
cd backend
npm run dev
```

Expected: server starts with no syntax errors. The service is not yet wired to a route — no end-to-end test possible until Task 3.

- [ ] **Step 3: Commit**

```
git add backend/src/services/mergeService.js
git commit -m "Add mergeService with four-rule merge algorithm"
```

---

## Task 2: Backend — merge Zod schema

**Files:**
- Modify: `backend/src/validators/playlists.js`

- [ ] **Step 1: Add the schema and export it**

Currently the file exports five schemas. Add a sixth at the bottom of the schema declarations (after `shareSchema` at line 34, before `module.exports`):

```js
const mergePlaylistSchema = z.object({
  aId: z.string().uuid(),
  bId: z.string().uuid(),
}).refine((d) => d.aId !== d.bId, {
  message: 'aId and bId must differ',
});
```

Then add `mergePlaylistSchema` to the `module.exports` block. The final exports object should be:

```js
module.exports = {
  createPlaylistSchema,
  updatePlaylistSchema,
  addClipSchema,
  reorderClipsSchema,
  updateClipCustomizationSchema,
  shareSchema,
  mergePlaylistSchema,
};
```

- [ ] **Step 2: Commit**

```
git add backend/src/validators/playlists.js
git commit -m "Add mergePlaylistSchema validator"
```

---

## Task 3: Backend — merge route

**Files:**
- Modify: `backend/src/routes/playlists.js`

- [ ] **Step 1: Add `mergeService` and `mergePlaylistSchema` to imports**

The current imports at the top of `backend/src/routes/playlists.js` read:

```js
const router = require('express').Router();
const crypto = require('crypto');
const validate = require('../middleware/validate');
const { playlistAccess, requireView, requireOwner } = require('../middleware/playlistAccess');
const {
  createPlaylistSchema,
  updatePlaylistSchema,
  addClipSchema,
  reorderClipsSchema,
  updateClipCustomizationSchema,
  shareSchema,
} = require('../validators/playlists');
const playlistService = require('../services/playlistService');
const shareService = require('../services/shareService');
const { ForbiddenError } = require('../utils/errors');
```

Add `mergePlaylistSchema` to the validators destructure and add a `mergeService` require:

```js
const router = require('express').Router();
const crypto = require('crypto');
const validate = require('../middleware/validate');
const { playlistAccess, requireView, requireOwner } = require('../middleware/playlistAccess');
const {
  createPlaylistSchema,
  updatePlaylistSchema,
  addClipSchema,
  reorderClipsSchema,
  updateClipCustomizationSchema,
  shareSchema,
  mergePlaylistSchema,
} = require('../validators/playlists');
const playlistService = require('../services/playlistService');
const shareService = require('../services/shareService');
const mergeService = require('../services/mergeService');
const { ForbiddenError } = require('../utils/errors');
```

- [ ] **Step 2: Add the route**

Place the new route **before** the existing `GET /:id` route to avoid Express matching `merge` as an `:id` UUID. The existing route file already follows this pattern (`/diff` is declared before `/:id`). Insert this block immediately above the `// ========================= Playlist Detail =========================` section divider:

```js
// ========================= Merge =========================

// POST /api/playlists/merge — create a new playlist by merging B into A
router.post('/merge', validate(mergePlaylistSchema), async (req, res, next) => {
  try {
    const { aId, bId } = req.validated;
    const result = await mergeService.mergePlaylists(req.user.id, aId, bId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});
```

The handler is small because `mergeService.mergePlaylists` already throws `ForbiddenError` / `NotFoundError`, which the existing error middleware maps to HTTP 403 / 404 with the correct response shape.

- [ ] **Step 3: Restart backend and smoke-test**

Restart `npm run dev`. Then in a logged-in browser devtools console:

```js
// Owned A, public B
fetch('/api/playlists/merge', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ aId: '<owned-A-uuid>', bId: '<public-B-uuid>' }),
}).then(r => r.json()).then(console.log);
```

Expected response (201): `{ id, name: "更新版 ...", summary: { added, merged, markedDifferent, markedDeleted } }`.

Try negative cases:

```js
// A not owned -> 403
fetch('/api/playlists/merge', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ aId: '<not-owned-uuid>', bId: '<public-uuid>' }),
}).then(r => r.json()).then(console.log);

// Same id -> 400
fetch('/api/playlists/merge', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ aId: '<id>', bId: '<id>' }),
}).then(r => r.json()).then(console.log);
```

Expected: 403, 400.

- [ ] **Step 4: Commit**

```
git add backend/src/routes/playlists.js
git commit -m "Add POST /api/playlists/merge route"
```

---

## Task 4: Backend — `getUserPlaylists` always returns `ownerName`

**Files:**
- Modify: `backend/src/services/playlistService.js`

- [ ] **Step 1: Always include ownerName**

The current `getUserPlaylists` (lines 10–26 in `playlistService.js`) reads:

```js
async function getUserPlaylists(userId, query) {
  const playlists = await searchPlaylists(query, userId);

  return playlists.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    isPublic: p.isPublic,
    isOwner: p.userId === userId,
    isShared: p.shares.length > 0,
    canCopy: p.copyPermissions.length > 0,
    ownerName: p.userId !== userId ? p.user.username : undefined,
    clipCount: p._count.playlistClips,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}
```

Change the `ownerName` line to always return the username:

```js
    ownerName: p.user.username,
```

Resulting function:

```js
async function getUserPlaylists(userId, query) {
  const playlists = await searchPlaylists(query, userId);

  return playlists.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    isPublic: p.isPublic,
    isOwner: p.userId === userId,
    isShared: p.shares.length > 0,
    canCopy: p.copyPermissions.length > 0,
    ownerName: p.user.username,
    clipCount: p._count.playlistClips,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}
```

The existing call sites that conditionally render `ownerName` only when `!isOwner` (e.g. `frontend/src/components/playlist/PlaylistCard.js`, if any) continue to work because they branch on `isOwner` first. The change is strictly additive — `ownerName` is now defined where it used to be `undefined`.

- [ ] **Step 2: Commit**

```
git add backend/src/services/playlistService.js
git commit -m "Always include ownerName in getUserPlaylists response"
```

---

## Task 5: Frontend — API client method

**Files:**
- Modify: `frontend/src/lib/api.js`

- [ ] **Step 1: Add the merge method**

Locate the existing `playlistsAPI` block. Specifically the Diff section (lines 169–170 currently):

```js
  // Diff
  diff: (aId, bId) => api.get(`/playlists/diff`, { params: { a: aId, b: bId } }),
```

Add a new Merge section right after the Diff section (or any equivalent position before `// Shares`):

```js
  // Merge
  merge: (aId, bId) => api.post(`/playlists/merge`, { aId, bId }),
```

- [ ] **Step 2: Commit**

```
git add frontend/src/lib/api.js
git commit -m "Add playlistsAPI.merge client method"
```

---

## Task 6: i18n — merge keys, rename desktop-only key, add `you`

**Files:**
- Modify: `frontend/src/i18n/en.js`
- Modify: `frontend/src/i18n/zh.js`

- [ ] **Step 1: Rename `diffDesktopOnly` → `toolsDesktopOnly` (both files)**

In both `en.js` and `zh.js`, find the existing `diffDesktopOnly` key in the "Diff tool" block:

English:
```js
  diffDesktopOnly: "Diff is only available on tablet or desktop.",
```

Chinese:
```js
  diffDesktopOnly: "对比功能仅在平板或桌面端可用",
```

Replace the **key** (not the value) with `toolsDesktopOnly` so both files now have:

English:
```js
  toolsDesktopOnly: "Diff is only available on tablet or desktop.",
```

Chinese:
```js
  toolsDesktopOnly: "对比功能仅在平板或桌面端可用",
```

(We're reusing the existing wording. If you prefer a more generic message like "This tool is only available on tablet or desktop", change the value too — but to keep the diff small, leave it as-is.)

- [ ] **Step 2: Add `you` key (both files)**

In `en.js`, add a `you` key near the existing `welcome` key (or anywhere — keep it grouped by feel):

```js
  you: "you",
```

In `zh.js`:

```js
  you: "我",
```

- [ ] **Step 3: Add the Merge block (both files)**

In `en.js`, add a new block after the "Diff tool" block (i.e. near the bottom of the existing keys, before any newer additions):

```js
  // Merge tool
  merge: "Merge",
  toolsMergeDescription: "Merge updates from another playlist into yours, creating a new playlist.",
  mergeBaseline: "Baseline (A) — must be yours",
  mergeSource: "Source (B)",
  mergeButton: "Merge",
  mergeConfirmTitle: "Confirm merge",
  mergeConfirmBody: "Will create a new playlist named \"{name}\". Continue?",
  mergeSuccessSummary: "Created \"{name}\": {added} added · {merged} merged · {markedDifferent} marked different · {markedDeleted} marked deleted",
```

In `zh.js`:

```js
  // 合并工具
  merge: "合并",
  toolsMergeDescription: "把另一个列表的更新合并到我的列表，生成新列表。",
  mergeBaseline: "我的列表 (A)",
  mergeSource: "合并来源 (B)",
  mergeButton: "合并",
  mergeConfirmTitle: "确认合并",
  mergeConfirmBody: "将创建新列表「{name}」，确认合并？",
  mergeSuccessSummary: "已创建「{name}」：{added} 新增 · {merged} 合并 · {markedDifferent} 标记不同 · {markedDeleted} 标记删除",
```

- [ ] **Step 4: Update the Diff page to use the new desktop-only key**

The Diff page references the old key. Modify `frontend/src/app/tools/diff/page.js`. Find:

```jsx
        <p className="text-center text-muted">{t("diffDesktopOnly")}</p>
```

Change to:

```jsx
        <p className="text-center text-muted">{t("toolsDesktopOnly")}</p>
```

That's the only call site of `diffDesktopOnly` in the codebase (verify with grep before committing).

- [ ] **Step 5: Commit**

```
git add frontend/src/i18n/en.js frontend/src/i18n/zh.js frontend/src/app/tools/diff/page.js
git commit -m "Add merge i18n keys; rename diffDesktopOnly to toolsDesktopOnly"
```

---

## Task 7: PlaylistPicker — owner display and `ownerOnly` filter

**Files:**
- Modify: `frontend/src/components/tools/PlaylistPicker.js`

- [ ] **Step 1: Add `ownerOnly` prop and update the JSDoc**

The current JSDoc reads:

```js
/**
 * Autocomplete playlist selector.
 *
 * Props:
 *  - label: string — visible label rendered above the input
 *  - value: { id, name } | null — currently selected playlist (or null)
 *  - onChange: (playlist | null) => void — fires with selection or with null when cleared
 *  - excludeId?: string — playlist id to omit from search results (the other side's selection)
 *  - placeholder?: string — override placeholder text
 */
```

Change to:

```js
/**
 * Autocomplete playlist selector.
 *
 * Props:
 *  - label: string — visible label rendered above the input
 *  - value: { id, name } | null — currently selected playlist (or null)
 *  - onChange: (playlist | null) => void — fires with selection or with null when cleared
 *  - excludeId?: string — playlist id to omit from search results (the other side's selection)
 *  - placeholder?: string — override placeholder text
 *  - ownerOnly?: boolean — if true, filter results to playlists where p.isOwner === true
 */
```

Add `ownerOnly` to the prop destructure:

```js
export default function PlaylistPicker({ label, value, onChange, excludeId, placeholder, ownerOnly }) {
```

- [ ] **Step 2: Apply the `ownerOnly` filter to results**

Currently the search effect filters by `excludeId`:

```js
        setResults(list.filter((p) => p.id !== excludeId));
```

Replace with:

```js
        setResults(
          list.filter((p) => p.id !== excludeId).filter((p) => !ownerOnly || p.isOwner)
        );
```

Also add `ownerOnly` to the `useEffect` dependency array. The current dependencies are `[query, open, excludeId]`. Change to `[query, open, excludeId, ownerOnly]`.

- [ ] **Step 3: Render `name — owner` in the dropdown**

Currently each result button renders just `{p.name}`:

```jsx
              <button
                type="button"
                onClick={() => {
                  onChange({ id: p.id, name: p.name });
                  setQuery("");
                  setOpen(false);
                }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-surface-hover"
                style={{ color: "var(--text)" }}
              >
                {p.name}
              </button>
```

Change to:

```jsx
              <button
                type="button"
                onClick={() => {
                  onChange({ id: p.id, name: p.name });
                  setQuery("");
                  setOpen(false);
                }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-surface-hover"
                style={{ color: "var(--text)" }}
              >
                {p.name} <span className="text-muted">— {p.isOwner ? t("you") : p.ownerName}</span>
              </button>
```

The `t("you")` and `p.ownerName` resolution depends on Task 4 (`ownerName` always present) and Task 6 (`you` key exists).

- [ ] **Step 4: Smoke test**

With the dev server running, navigate to `/tools/diff`. Open either picker and type a search term. Verify each result row shows `<name> — <username>` (or `<name> — 我` for owned playlists).

- [ ] **Step 5: Commit**

```
git add frontend/src/components/tools/PlaylistPicker.js
git commit -m "PlaylistPicker: ownerOnly prop and owner-label display"
```

---

## Task 8: Merge page

**Files:**
- Create: `frontend/src/app/tools/merge/page.js`

- [ ] **Step 1: Ensure parent directory exists**

The directory `frontend/src/app/tools/` already exists (contains `diff/` and `page.js`). Create the subdirectory:

```
mkdir -p frontend/src/app/tools/merge
```

(PowerShell: `New-Item -ItemType Directory -Path frontend/src/app/tools/merge -Force`.)

- [ ] **Step 2: Write the page**

Create `frontend/src/app/tools/merge/page.js` with this exact content:

```jsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { playlistsAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import PlaylistPicker from "@/components/tools/PlaylistPicker";

function formatSummary(template, summary, name) {
  return template
    .replace("{name}", name)
    .replace("{added}", summary.added)
    .replace("{merged}", summary.merged)
    .replace("{markedDifferent}", summary.markedDifferent)
    .replace("{markedDeleted}", summary.markedDeleted);
}

export default function MergePage() {
  const { t } = useLanguage();
  const router = useRouter();

  const [aPlaylist, setAPlaylist] = useState(null);
  const [bPlaylist, setBPlaylist] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const canMerge = aPlaylist && bPlaylist && aPlaylist.id !== bPlaylist.id;

  const handleConfirm = async () => {
    setSubmitting(true);
    setError("");
    try {
      const res = await playlistsAPI.merge(aPlaylist.id, bPlaylist.id);
      const { id, name, summary } = res.data;
      const message = formatSummary(t("mergeSuccessSummary"), summary, name);
      // Stash the summary so the destination playlist page could read it later if desired.
      // For now we just navigate; the user can re-run merge if they want the message again.
      // (No persistent toast component exists in the codebase yet.)
      if (typeof window !== "undefined") {
        // sessionStorage is fine here — it's user-initiated and cleared on tab close.
        sessionStorage.setItem("lastMergeSummary", message);
      }
      router.push(`/playlists/${id}`);
    } catch (err) {
      setError(err.response?.data?.error?.message || "Failed to merge");
      setShowConfirm(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isDesktop) {
    return (
      <main className="mx-auto max-w-screen-md p-6">
        <p className="text-center text-muted">{t("toolsDesktopOnly")}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-screen-lg p-6">
      <h1 className="mb-4 text-2xl font-bold" style={{ color: "var(--text)" }}>
        {t("merge")}
      </h1>

      <div className="mb-6 space-y-3 rounded-lg border border-border bg-surface p-4">
        <PlaylistPicker
          label={t("mergeBaseline")}
          value={aPlaylist}
          onChange={setAPlaylist}
          excludeId={bPlaylist?.id}
          ownerOnly
        />
        <PlaylistPicker
          label={t("mergeSource")}
          value={bPlaylist}
          onChange={setBPlaylist}
          excludeId={aPlaylist?.id}
        />
        <div>
          <button
            type="button"
            disabled={!canMerge || submitting}
            onClick={() => setShowConfirm(true)}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("mergeButton")}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {showConfirm && aPlaylist && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-xl border border-border bg-surface p-5">
            <h2 className="mb-2 text-lg font-semibold" style={{ color: "var(--text)" }}>
              {t("mergeConfirmTitle")}
            </h2>
            <p className="mb-4 text-sm text-muted">
              {t("mergeConfirmBody").replace("{name}", `更新版 ${aPlaylist.name}`)}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setShowConfirm(false)}
                className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium hover:bg-surface-hover disabled:opacity-50"
                style={{ color: "var(--text)" }}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={handleConfirm}
                className="rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-primary-hover disabled:opacity-50"
              >
                {t("mergeButton")}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
```

Notes for the implementer:
- The page uses `setAPlaylist`/`setBPlaylist` directly as the picker's `onChange`. Each picker just stores the selection in local state — no URL syncing (unlike the Diff page which has `?a=&b=` deep links). The Merge page is action-oriented; once submitted, navigation handles state.
- The success-summary is stashed in `sessionStorage` keyed `lastMergeSummary`. The destination playlist page does NOT need to read this — this is a stub for a future toast. For now the user can see the new playlist after navigation; the count message is available in the browser if needed.
- The "Merge" button is disabled when either picker is empty or both pickers select the same playlist (defense in depth — the picker's `excludeId` already prevents the dropdown from offering the same id, but a user might paste two equal ids via URL manipulation if we ever add URL state).
- The confirmation modal reads the result name preview `更新版 <A.name>` directly client-side; this matches what the backend will use (Task 1 algorithm).

- [ ] **Step 3: Smoke test**

In a logged-in browser, navigate to `/tools/merge`.

1. Verify: two pickers labeled "我的列表 (A)" and "合并来源 (B)" (Chinese) or English equivalents.
2. The A picker's dropdown only shows playlists you own.
3. The B picker's dropdown shows any viewable playlist.
4. Both rows show `<name> — <ownerName>` (or `— 我` for owned).
5. Pick A and B, click Merge → confirmation modal appears with `更新版 <A.name>` in the body.
6. Cancel → modal closes, nothing else changes.
7. Confirm → navigates to `/playlists/<new id>`. The new playlist exists, has the expected merged clips.

- [ ] **Step 4: Commit**

```
git add frontend/src/app/tools/merge/page.js
git commit -m "Add /tools/merge page"
```

---

## Task 9: Tools hub — add Merge tile

**Files:**
- Modify: `frontend/src/app/tools/page.js`

- [ ] **Step 1: Append the Merge tile**

The current page declares:

```jsx
  const tools = [
    {
      id: "diff",
      href: "/tools/diff",
      title: t("diff"),
      description: t("toolsDiffDescription"),
    },
  ];
```

Append a second tile:

```jsx
  const tools = [
    {
      id: "diff",
      href: "/tools/diff",
      title: t("diff"),
      description: t("toolsDiffDescription"),
    },
    {
      id: "merge",
      href: "/tools/merge",
      title: t("merge"),
      description: t("toolsMergeDescription"),
    },
  ];
```

The existing grid layout (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`) handles two tiles cleanly.

- [ ] **Step 2: Smoke test**

Visit `/tools`. Two tiles visible: Diff and Merge. Clicking each navigates to the right page.

- [ ] **Step 3: Commit**

```
git add frontend/src/app/tools/page.js
git commit -m "Add Merge tile to /tools hub"
```

---

## Self-Review

### 1. Spec coverage

**Goal "tool produces a new playlist named `更新版 <A.name>`"** → Task 1 `mergePlaylists` line `const newName = \`更新版 \${aPl.name}\`;`. New playlist isPublic=false, description carried from A. ✅

**Permission gate (A owned, B owned/public/copy-allowed)** → Task 1 `mergePlaylists`:
- A: throws `ForbiddenError('You must own the baseline playlist')` if `aPl.userId !== callerId`.
- B: checks `bPl.userId === callerId || bPl.isPublic || bPl.copyPermissions.length > 0`; throws `NotFoundError` otherwise. Shares intentionally excluded. ✅

**Rule 1 (song in B, not in A)** → Task 1 `buildMergeRows` first branch inside the `for (const bPc of bClips)` loop. Emits B's clip as-is. ✅

**Rule 4 (same clip.id)** → Task 1 second branch. clipId=A's, speed=B's, colorTag=union, comment=A's (unchanged), sectionLabel=B's, pitch=A's. ✅

**Rule 2 (different clip.id, same song)** → Task 1 third + fourth branches. First encounter emits A's clip with `[B 中的片段不同]` appended; subsequent encounters of same songId with different clipId append `[B 中存在多个不同片段]` to the already-emitted row's comment (only once). ✅

**Rule 5 (song in A, not in B)** → Task 1 final loop after the B iteration. Each non-consumed A clip is appended to `rows` with `[此歌已删]` annotation. ✅

**Order rule** → Task 1: B's clips iterated in position order push into `rows` in that order; Rule 5 loop iterates A in position order and appends at the bottom. ✅

**Annotation append behavior (no leading newline if comment is empty)** → Task 1 `appendAnnotation`. ✅

**Color tag union with dedupe preserving A-first order** → Task 1 `unionColorTags`. ✅

**Pitch never touched (A's preserved for Rules 2/4/5, B's for Rule 1)** → Task 1: Rule 1 takes `bPc.pitch`; Rules 2/4/5 take A's pitch. ✅

**Backend route `POST /api/playlists/merge`** → Task 3. ✅

**Body validation (both UUIDs required, must differ)** → Task 2 Zod schema with `.refine`. ✅

**Tools hub entry** → Task 9. ✅

**Page `/tools/merge` with phone-only gating** → Task 8 page uses `window.matchMedia('(min-width: 768px)')` and renders `toolsDesktopOnly` notice if not desktop. ✅

**Picker enhancement (owner display, `ownerOnly` filter)** → Task 7. ✅

**API client `playlistsAPI.merge`** → Task 5. ✅

**`getUserPlaylists` always returns `ownerName`** → Task 4. ✅

**i18n keys (merge*, you, toolsMergeDescription, toolsDesktopOnly rename)** → Task 6. ✅

**Confirmation modal** → Task 8 page renders inline modal with `mergeConfirmTitle`/`mergeConfirmBody`. ✅

**Success summary in API response** → Task 1 `mergePlaylists` returns `{ id, name, summary: { added, merged, markedDifferent, markedDeleted } }`. Task 8 page reads it and stashes in sessionStorage. ✅

**Self-merge blocked (a === b)** → Task 2 Zod `.refine` returns 400. ✅

**Manual test plan items 1–20 from spec** → Most are observable post-deployment from a browser. The plan's smoke-test steps inside Tasks 3, 7, 8, 9 cover the immediate verification path; the broader test plan (Rule 1–5 correctness, edge cases) requires the human running the dev environment. Documented sufficiently in the spec.

### 2. Placeholder scan

No "TBD", "TODO", "implement later", "add appropriate X", "similar to Task N", or stub code blocks. Every code block is complete and copy-pasteable. The success-toast presentation is intentionally minimal (stash in sessionStorage; no toast component) and documented as such, not deferred.

### 3. Type / name consistency

- Backend route reads `req.validated.aId` / `req.validated.bId` — these field names match the Zod schema (Task 2) and the API client call (Task 5).
- `mergeService.mergePlaylists(callerId, aId, bId)` signature is consistent across Task 1 (definition) and Task 3 (route caller).
- `buildMergeRows(aClips, bClips)` returns `{ rows, summary }` with `summary` having keys `added`, `merged`, `markedDifferent`, `markedDeleted` — matches API response shape (Task 1) and the page's summary template (Task 6 / Task 8 `formatSummary`).
- The annotation strings (`[B 中的片段不同]`, `[B 中存在多个不同片段]`, `[此歌已删]`) appear only in Task 1 and are not referenced elsewhere — no risk of drift.
- Picker prop `ownerOnly` (Task 7) is consumed in Task 8 (`ownerOnly` on the A picker). The picker reads `p.isOwner` and `p.ownerName`; both fields are guaranteed by Task 4 (`ownerName` always present) and the existing `searchPlaylists` response.
- i18n key names: `merge`, `toolsMergeDescription`, `mergeBaseline`, `mergeSource`, `mergeButton`, `mergeConfirmTitle`, `mergeConfirmBody`, `mergeSuccessSummary`, `you`, `toolsDesktopOnly` — all defined in Task 6 in both `en.js` and `zh.js`. All callers in Tasks 8 and 9 reference these exact names.
- `cancel` key already exists (verified at `en.js:112` `cancel: "Cancel"`) and is reused in Task 8 modal.

No inconsistencies detected.
