# Tools Hub + Diff Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `/tools` hub page that lists future utilities (starting with Diff), move the navbar link from "Diff" to "Tools", remove the Diff entry from the playlist overflow menu, and refine the diff comparison so that two clips of the same song with different boundaries pair as a modification rather than a removal+addition.

**Architecture:** Two coupled changes shipped together. Part 1 adds a hub page and adjusts entry points (navbar + i18n + playlist header cleanup). Part 2 rewrites `buildDiff` to do two-pass matching: first by `clipId`, then by `songId` for unmatched rows, with a new `clipBoundaries` field in the diff output. The Prisma `include` widens to fetch `clip.songId`, `clip.start`, `clip.length` for both sides.

**Tech Stack:** Express.js, Prisma, Next.js 14 App Router, React 18, Tailwind, plain JavaScript.

**Spec:** [`docs/superpowers/specs/2026-05-10-tools-hub-and-diff-matching-design.md`](../specs/2026-05-10-tools-hub-and-diff-matching-design.md)

---

## File Structure

**Backend:**
- Modify: `backend/src/routes/playlists.js` — rewrite `buildDiff` for two-pass matching; widen the `clip` include to fetch `songId`, `start`, `length`.

**Frontend (new):**
- Create: `frontend/src/app/tools/page.js` — hub page; one tile per tool.

**Frontend (modified):**
- Modify: `frontend/src/components/tools/DiffReport.js` — render the new `clipBoundaries` field as `start=N,len=N`.
- Modify: `frontend/src/components/layout/Navbar.js` — replace the "Diff" navbar link with "Tools" pointing to `/tools`.
- Modify: `frontend/src/components/playlist/PlaylistHeader.js` — remove the diff overflow item and the now-unused `useRouter`/`isDesktop`/`useEffect` machinery added when the menu item was introduced.
- Modify: `frontend/src/i18n/en.js` — add `navTools`, `tools`, `toolsDiffDescription`; remove `navDiff`.
- Modify: `frontend/src/i18n/zh.js` — same.

No tests. The project has no automated test suite for either backend or frontend; verification is manual per the spec's test plan.

Task order: backend first (so the API response shape exists when the frontend reads it), then `DiffReport` (to consume the new shape), then i18n, then hub page, navbar, header cleanup. Order is deliberate — each commit leaves the app in a working state.

---

## Task 1: Backend — two-pass diff matching

**Files:**
- Modify: `backend/src/routes/playlists.js` — `buildDiff` function (currently lines 91–158) and the `findMany` `include` clauses (currently lines 210 and 215).

- [ ] **Step 1: Expand the `findMany` include to fetch songId/start/length**

The current `findMany` calls fetch only `clip.song.{title,artist}`. The new `buildDiff` needs `clip.id` (already exposed via `pc.clipId`), `clip.songId`, `clip.start`, and `clip.length`. Open `backend/src/routes/playlists.js` and locate the `findMany` block (currently around lines 206–217):

```js
    const [aClips, bClips] = await Promise.all([
      prisma.playlistClip.findMany({
        where: { playlistId: a },
        orderBy: { position: 'asc' },
        include: { clip: { select: { song: { select: { title: true, artist: true } } } } },
      }),
      prisma.playlistClip.findMany({
        where: { playlistId: b },
        orderBy: { position: 'asc' },
        include: { clip: { select: { song: { select: { title: true, artist: true } } } } },
      }),
    ]);
```

Change both `include` clauses so each clip select also returns `id`, `songId`, `start`, `length`:

```js
    const [aClips, bClips] = await Promise.all([
      prisma.playlistClip.findMany({
        where: { playlistId: a },
        orderBy: { position: 'asc' },
        include: {
          clip: {
            select: {
              id: true,
              songId: true,
              start: true,
              length: true,
              song: { select: { title: true, artist: true } },
            },
          },
        },
      }),
      prisma.playlistClip.findMany({
        where: { playlistId: b },
        orderBy: { position: 'asc' },
        include: {
          clip: {
            select: {
              id: true,
              songId: true,
              start: true,
              length: true,
              song: { select: { title: true, artist: true } },
            },
          },
        },
      }),
    ]);
```

- [ ] **Step 2: Replace `buildDiff` with the two-pass implementation**

The current `buildDiff` (lines 91–158) does a single-pass `clipId`-only match. Replace it entirely with this two-pass implementation. The new function uses the additional `clip.songId`, `clip.start`, `clip.length` fields surfaced by Step 1.

```js
/**
 * Build a one-directional diff: B relative to A.
 * Inputs are arrays of playlistClip rows that include clip.id, clip.songId,
 * clip.start, clip.length, and clip.song.{title,artist}.
 *
 * Two-pass matching:
 *   1. Match by clip.id (same clip row). Differing metadata -> modifiedInB.
 *   2. Among unmatched rows, pair by clip.songId in playlist-position order.
 *      Each pair becomes a modifiedInB entry with `clipBoundaries` in its diffs.
 *      Leftovers go to newInB / removedFromB.
 *
 * Comparison rules for metadata fields:
 *   - speed: numeric exact equality
 *   - colorTag: nullable string; strict === (null != "")
 *   - comment: nullable string; null and "" treated as equal; trimmed
 *   - sectionLabel: nullable string; null and "" treated as equal; trimmed
 *   - clipBoundaries: true if clip.start OR clip.length differs
 *   - position and pitch are NOT compared
 */
function buildDiff(aRows, bRows) {
  const normalize = (v) => {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  };
  const equalText = (x, y) => normalize(x) === normalize(y);

  const formatNewOrRemoved = (pc) => ({
    clipId: pc.clipId,
    song: { title: pc.clip.song.title, artist: pc.clip.song.artist },
    speed: pc.speed,
    colorTag: pc.colorTag,
    comment: pc.comment,
    sectionLabel: pc.sectionLabel,
  });

  const computeDiffs = (aPc, bPc) => {
    const diffs = [];
    if (aPc.speed !== bPc.speed) diffs.push('speed');
    if (aPc.colorTag !== bPc.colorTag) diffs.push('colorTag');
    if (!equalText(aPc.comment, bPc.comment)) diffs.push('comment');
    if (!equalText(aPc.sectionLabel, bPc.sectionLabel)) diffs.push('sectionLabel');
    if (
      aPc.clip.start !== bPc.clip.start ||
      aPc.clip.length !== bPc.clip.length
    ) {
      diffs.push('clipBoundaries');
    }
    return diffs;
  };

  const buildModifiedEntry = (aPc, bPc, diffs, sameClipId) => {
    const entry = {
      clipId: bPc.clipId,
      song: { title: bPc.clip.song.title, artist: bPc.clip.song.artist },
      a: {
        speed: aPc.speed,
        colorTag: aPc.colorTag,
        comment: aPc.comment,
        sectionLabel: aPc.sectionLabel,
        start: aPc.clip.start,
        length: aPc.clip.length,
      },
      b: {
        speed: bPc.speed,
        colorTag: bPc.colorTag,
        comment: bPc.comment,
        sectionLabel: bPc.sectionLabel,
        start: bPc.clip.start,
        length: bPc.clip.length,
      },
      diffs,
    };
    if (!sameClipId) entry.aClipId = aPc.clipId;
    return entry;
  };

  // ---- Pass 1: match by clip.id ----
  const aById = new Map();
  for (const pc of aRows) aById.set(pc.clipId, pc);
  const bById = new Map();
  for (const pc of bRows) bById.set(pc.clipId, pc);

  const modifiedInB = [];
  const aUnmatched = [];
  const bUnmatched = [];

  for (const aPc of aRows) {
    if (!bById.has(aPc.clipId)) {
      aUnmatched.push(aPc);
    }
  }
  for (const bPc of bRows) {
    if (!aById.has(bPc.clipId)) {
      bUnmatched.push(bPc);
      continue;
    }
    const aPc = aById.get(bPc.clipId);
    const diffs = computeDiffs(aPc, bPc);
    if (diffs.length > 0) {
      modifiedInB.push(buildModifiedEntry(aPc, bPc, diffs, true));
    }
  }

  // ---- Pass 2: pair leftovers by clip.songId in order ----
  const aBySongId = new Map();
  for (const pc of aUnmatched) {
    if (!aBySongId.has(pc.clip.songId)) aBySongId.set(pc.clip.songId, []);
    aBySongId.get(pc.clip.songId).push(pc);
  }
  const bBySongId = new Map();
  for (const pc of bUnmatched) {
    if (!bBySongId.has(pc.clip.songId)) bBySongId.set(pc.clip.songId, []);
    bBySongId.get(pc.clip.songId).push(pc);
  }

  const newInB = [];
  const removedFromB = [];

  // For each songId in B's leftovers, try to pair with A's leftovers of the same song.
  for (const [songId, bList] of bBySongId) {
    const aList = aBySongId.get(songId) || [];
    const pairCount = Math.min(aList.length, bList.length);
    for (let i = 0; i < pairCount; i++) {
      const aPc = aList[i];
      const bPc = bList[i];
      const diffs = computeDiffs(aPc, bPc);
      if (diffs.length > 0) {
        modifiedInB.push(buildModifiedEntry(aPc, bPc, diffs, false));
      }
      // If diffs is empty (same song, same boundaries, same metadata, different clipId),
      // intentionally skip — no change to report.
    }
    // Anything in B beyond the paired prefix is genuinely new.
    for (let i = pairCount; i < bList.length; i++) {
      newInB.push(formatNewOrRemoved(bList[i]));
    }
  }

  // Anything in A whose songId never appeared in B's leftovers, OR whose count
  // exceeded B's count for that songId, goes to removedFromB.
  for (const [songId, aList] of aBySongId) {
    const bList = bBySongId.get(songId) || [];
    const pairCount = Math.min(aList.length, bList.length);
    for (let i = pairCount; i < aList.length; i++) {
      removedFromB.push({
        clipId: aList[i].clipId,
        song: {
          title: aList[i].clip.song.title,
          artist: aList[i].clip.song.artist,
        },
      });
    }
  }

  return { newInB, modifiedInB, removedFromB };
}
```

Notes for the implementer:
- The signature is unchanged: `buildDiff(aRows, bRows)`. Callers don't need updating.
- The `aClipId` field on modified entries is added ONLY for `songId`-paired rows (so the frontend can later show that the clipId itself changed, if needed). For `clipId`-paired rows, `aClipId === clipId` is implicit and the field is omitted.
- Same-song-different-clipId entries with no actual diffs are skipped (no entry produced) — they're not real changes, just identity churn.

- [ ] **Step 3: Restart the backend dev server**

Stop the running backend (Ctrl-C in its terminal, or `taskkill /F /IM node.exe` on Windows if detached). Then:

```
cd backend
npm run dev
```

Expected: server starts cleanly with no syntax errors.

- [ ] **Step 4: Smoke test the new logic**

In the browser devtools console on `http://localhost:3000` (logged in):

```js
fetch('/api/playlists/diff?a=<A_ID>&b=<B_ID>', { credentials: 'include' })
  .then(r => r.json()).then(console.log);
```

Replace `<A_ID>` and `<B_ID>` with two playlists you have view access to where you know B has at least one clip of a song that A also has at a different `start`.

Expected: that song appears in `modifiedInB` with `"clipBoundaries"` in its `diffs` array and `a.start`/`a.length` vs `b.start`/`b.length` differing. The previous behavior (one row in `removedFromB`, another in `newInB`) is gone.

- [ ] **Step 5: Commit**

```
git add backend/src/routes/playlists.js
git commit -m "Pair diff clips by songId when clipId differs"
```

---

## Task 2: Frontend — DiffReport handles `clipBoundaries`

**Files:**
- Modify: `frontend/src/components/tools/DiffReport.js`

- [ ] **Step 1: Open the file**

`DiffReport.js` currently renders modified rows by iterating `row.diffs` and reading `row.a[field]` / `row.b[field]` via a `formatValue` helper. The new `clipBoundaries` field requires reading `start` and `length` together rather than a single property.

The current modified-row block reads:

```jsx
        {report.modifiedInB.map((row) => (
          <div key={row.clipId} className="rounded-md bg-background p-2">
            <div className="text-sm font-medium" style={{ color: "var(--text)" }}>
              {row.song.title} — <span className="text-muted">{row.song.artist}</span>
            </div>
            <ul className="mt-1 space-y-0.5 text-xs">
              {row.diffs.map((field) => (
                <li key={field} className="text-muted">
                  <span className="font-medium" style={{ color: "var(--text)" }}>
                    {fieldLabel[field] || field}:
                  </span>{" "}
                  {formatValue(row.a[field])} → {formatValue(row.b[field])}
                </li>
              ))}
            </ul>
          </div>
        ))}
```

- [ ] **Step 2: Add a `clip` label and a per-field formatter**

Above the existing `fieldLabel` constant near the top of `DiffReport`, add `clipBoundaries: "clip"` to the map.

The current map:

```js
  const fieldLabel = {
    speed: "speed",
    colorTag: "tag",
    comment: "comment",
    sectionLabel: "section",
  };
```

Becomes:

```js
  const fieldLabel = {
    speed: "speed",
    colorTag: "tag",
    comment: "comment",
    sectionLabel: "section",
    clipBoundaries: "clip",
  };
```

Then add a helper above the `return` statement of `DiffReport` (right after the `fieldLabel` declaration):

```js
  const renderFieldValue = (field, side) => {
    if (field === "clipBoundaries") {
      return `start=${side.start},len=${side.length}`;
    }
    return formatValue(side[field]);
  };
```

- [ ] **Step 3: Use the helper in the modified-row map**

Replace the existing modified-row diff list (the `{row.diffs.map((field) => ...)}` block) with one that uses the helper:

```jsx
            <ul className="mt-1 space-y-0.5 text-xs">
              {row.diffs.map((field) => (
                <li key={field} className="text-muted">
                  <span className="font-medium" style={{ color: "var(--text)" }}>
                    {fieldLabel[field] || field}:
                  </span>{" "}
                  {renderFieldValue(field, row.a)} → {renderFieldValue(field, row.b)}
                </li>
              ))}
            </ul>
```

Only the two `formatValue(row.{a,b}[field])` calls change to `renderFieldValue(field, row.{a,b})`. The `key={field}` and surrounding markup stay the same.

- [ ] **Step 4: Smoke test in browser**

With both servers running, visit `/tools/diff?a=<A>&b=<B>` where B has at least one clip of a song that A also has at a different `start`. The modified row should now show a `clip:` line like `clip: start=30,len=20 → start=59,len=20`.

- [ ] **Step 5: Commit**

```
git add frontend/src/components/tools/DiffReport.js
git commit -m "Render clipBoundaries field in DiffReport"
```

---

## Task 3: i18n — add tools keys, remove unused navDiff

**Files:**
- Modify: `frontend/src/i18n/en.js`
- Modify: `frontend/src/i18n/zh.js`

- [ ] **Step 1: Update `en.js`**

Open `frontend/src/i18n/en.js`. Locate the existing "Diff tool" block (added in a prior task). It currently contains `diff: "Diff",` and `navDiff: "Diff",` among other keys.

Remove the `navDiff` line. Then add three new keys to the same block (or to a new "Tools" block immediately above — either is fine, just be consistent). The final relevant section should contain:

```js
  // Tools
  navTools: "Tools",
  tools: "Tools",
  toolsDiffDescription: "Compare a baseline playlist against a current one and see what changed.",

  // Diff tool
  diff: "Diff",
  diffBaseline: "Baseline (A)",
  diffCurrent: "Current (B)",
  diffSwap: "Swap",
  diffChange: "change",
  diffSelectPlaylist: "Search for a playlist…",
  diffNewInB: "New in current",
  diffModifiedInB: "Modified in current",
  diffRemovedFromB: "Removed from current",
  diffNoNew: "No new clips",
  diffNoModified: "No modifications",
  diffNoRemoved: "No removed clips",
  diffSummary: "{n} new · {m} modified · {k} removed",
  diffDesktopOnly: "Diff is only available on tablet or desktop.",
  diffSameError: "Cannot diff a playlist against itself",
  diffEmpty: "Pick two playlists to compare.",
```

Note: the only differences from the current state are (a) `navDiff` is gone, and (b) three new keys at the top of a new "Tools" block.

- [ ] **Step 2: Update `zh.js`**

Mirror the same changes in `frontend/src/i18n/zh.js`. The final relevant section should contain:

```js
  // 工具
  navTools: "工具",
  tools: "工具",
  toolsDiffDescription: "对比两个列表，查看片段差异。",

  // 对比工具
  diff: "片段对比",
  diffBaseline: "原始列表 A",
  diffCurrent: "当前列表 B",
  diffSwap: "交换",
  diffChange: "更换",
  diffSelectPlaylist: "搜索列表…",
  diffNewInB: "新增",
  diffModifiedInB: "已修改",
  diffRemovedFromB: "已删除",
  diffNoNew: "没有新增片段",
  diffNoModified: "没有修改",
  diffNoRemoved: "没有删除片段",
  diffSummary: "新增 {n} · 修改 {m} · 删除 {k}",
  diffDesktopOnly: "对比功能仅在平板或桌面端可用",
  diffSameError: "无法和自身对比",
  diffEmpty: "请选择两个列表进行对比",
```

(Same content as before; `navDiff` removed; `navTools`/`tools`/`toolsDiffDescription` added.)

- [ ] **Step 3: Commit**

```
git add frontend/src/i18n/en.js frontend/src/i18n/zh.js
git commit -m "Add tools i18n keys; remove unused navDiff"
```

---

## Task 4: Tools hub page

**Files:**
- Create: `frontend/src/app/tools/page.js`

- [ ] **Step 1: Confirm the parent directory exists**

`frontend/src/app/tools/` already exists (it contains `diff/page.js`). No mkdir needed. Verify:

```
ls frontend/src/app/tools
```

Expected: at least `diff/` is present.

- [ ] **Step 2: Write the hub page**

Create `frontend/src/app/tools/page.js` with this content:

```jsx
"use client";

import Link from "next/link";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ToolsPage() {
  const { t } = useLanguage();

  const tools = [
    {
      id: "diff",
      href: "/tools/diff",
      title: t("diff"),
      description: t("toolsDiffDescription"),
    },
  ];

  return (
    <main className="mx-auto max-w-screen-lg p-6">
      <h1 className="mb-4 text-2xl font-bold" style={{ color: "var(--text)" }}>
        {t("tools")}
      </h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map((tool) => (
          <Link
            key={tool.id}
            href={tool.href}
            className="block rounded-lg border border-border bg-surface p-4 transition-colors hover:bg-surface-hover"
          >
            <div className="text-base font-semibold" style={{ color: "var(--text)" }}>
              {tool.title}
            </div>
            <p className="mt-1 text-sm text-muted">{tool.description}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
```

Notes for the implementer:
- The `tools` array is declared inside the component so future additions are a one-liner. Keep this pattern.
- Tile sizing uses the existing Tailwind responsive grid utilities — `grid-cols-1` on phone widens to 2 then 3 columns on larger viewports. The page itself is NOT desktop-only; phone users can still see and click the Diff tile (the Diff page handles its own phone gating).
- No additional styling, animations, or icons — YAGNI.

- [ ] **Step 3: Smoke test in browser**

Visit `/tools` in the running dev server. Expected: a single "Diff" tile with the description string from i18n. Clicking it navigates to `/tools/diff`.

- [ ] **Step 4: Commit**

```
git add frontend/src/app/tools/page.js
git commit -m "Add /tools hub page"
```

---

## Task 5: Navbar — replace Diff with Tools

**Files:**
- Modify: `frontend/src/components/layout/Navbar.js`

- [ ] **Step 1: Locate the desktop nav row**

The current desktop nav row reads:

```jsx
            <div className="hidden items-center gap-1 md:flex">
              {navLink("/playlists", t("navPlaylists"))}
              {navLink("/tools/diff", t("navDiff"))}
              {navLink("/guide", t("navGuide"))}
              {navLink("/feedback", t("navFeedback"))}
              {isAdmin && navLink("/admin", t("navAdmin"))}
              {navLink("/settings", t("navSettings"))}
```

- [ ] **Step 2: Replace the diff link with the tools link**

Change `"/tools/diff"` and `t("navDiff")` to `"/tools"` and `t("navTools")`:

```jsx
            <div className="hidden items-center gap-1 md:flex">
              {navLink("/playlists", t("navPlaylists"))}
              {navLink("/tools", t("navTools"))}
              {navLink("/guide", t("navGuide"))}
              {navLink("/feedback", t("navFeedback"))}
              {isAdmin && navLink("/admin", t("navAdmin"))}
              {navLink("/settings", t("navSettings"))}
```

The mobile dropdown (lower in the same file) has never contained the diff link and should remain untouched.

Note: `navLink` uses `pathname?.startsWith(href)` for the active state. With `href="/tools"`, both `/tools` and `/tools/diff` will activate the link — desired behavior, since "Diff" is a tool under the Tools section.

- [ ] **Step 3: Commit**

```
git add frontend/src/components/layout/Navbar.js
git commit -m "Replace Diff navbar link with Tools"
```

---

## Task 6: PlaylistHeader — remove diff overflow item and dead viewport code

**Files:**
- Modify: `frontend/src/components/playlist/PlaylistHeader.js`

- [ ] **Step 1: Remove the diff overflow item**

Locate the `overflowItems` array. The diff item currently reads:

```jsx
    {
      id: "diff",
      label: t("diff"),
      onClick: () => router.push(`/tools/diff?b=${playlist.id}`),
      hidden: editMode || !isDesktop,
    },
```

Delete this entire entry. The surrounding items (`compare`, `compact`, etc.) stay.

- [ ] **Step 2: Remove the now-unused viewport detection and router import**

The diff item was the only consumer of `router`, `isDesktop`, and the `useEffect` listening to `matchMedia`. With the item removed, this state is dead code. Clean it up.

Currently the component body starts with:

```jsx
  const router = useRouter();
  const [editName, setEditName] = useState(playlist.name);
  const [editDesc, setEditDesc] = useState(playlist.description || "");
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
```

Change to:

```jsx
  const [editName, setEditName] = useState(playlist.name);
  const [editDesc, setEditDesc] = useState(playlist.description || "");
```

That is: remove the `const router = useRouter();` line, the `const [isDesktop, setIsDesktop] = useState(true);` line, and the entire `useEffect` block.

- [ ] **Step 3: Remove the now-unused imports**

The top of the file currently reads:

```jsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";
import OverflowMenu from "@/components/ui/OverflowMenu";
import useAuth from "@/hooks/useAuth";
import usePlayerStore from "@/store/playerStore";
```

`useEffect` and `useRouter` are no longer used anywhere in this file (verify by reading through; the only usages were inside the deleted block). Change to:

```jsx
"use client";

import { useState } from "react";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";
import OverflowMenu from "@/components/ui/OverflowMenu";
import useAuth from "@/hooks/useAuth";
import usePlayerStore from "@/store/playerStore";
```

- [ ] **Step 4: Smoke test**

Watch the frontend dev server terminal for a clean HMR recompile. Open any playlist's overflow menu — confirm "Diff" is no longer there. The remaining menu items (Share, AutoPlay (admin only), Compare, Compact, Public) still work.

- [ ] **Step 5: Commit**

```
git add frontend/src/components/playlist/PlaylistHeader.js
git commit -m "Remove Diff from playlist overflow menu"
```

---

## Self-Review

### 1. Spec coverage

**Part 1 — Tools hub:**

- "New page `/tools` showing one tile per available tool" → Task 4 creates `frontend/src/app/tools/page.js`.
- "Initial content: a single Diff tile linking to `/tools/diff`" → Task 4's `tools` array has exactly one entry.
- "Tile shows tool name and a one-line description (`t("toolsDiffDescription")`)" → Task 4 reads both, Task 3 adds the key.
- "Navbar shows Tools between Playlists and Guide, desktop-only" → Task 5 (the existing nav row gating uses `md:flex`, which Task 5 preserves).
- "Remove the diff item from the playlist overflow menu entirely" → Task 6 Step 1.
- "Cleanup: remove the unused `isDesktop`/`useEffect`/`useRouter`/`useEffect` import" → Task 6 Steps 2 + 3.
- "Cleanup: remove `navDiff` from both files" → Task 3 Steps 1 + 2.
- "Add `navTools`, `tools`, `toolsDiffDescription`" → Task 3 adds all three in both languages.
- "The `/tools` page itself does NOT need phone-only gating" → Task 4 contains no phone gating; the existing phone gate on `/tools/diff` is untouched.

**Part 2 — Diff matching refinement:**

- "First pass: match by `clip.id`" → Task 1 `buildDiff` Pass 1 builds `aById`/`bById` and pairs by `clipId`.
- "Second pass: for unmatched, pair by `clip.songId` in playlist-position order" → Task 1 `buildDiff` Pass 2 builds `aBySongId`/`bBySongId` maps and pairs by index (which is `position`-asc because the `findMany` calls already sort that way).
- "Each pair becomes `modifiedInB` with `clipBoundaries` in `diffs`" → Task 1 `computeDiffs` pushes `clipBoundaries` when start or length differ, and `buildModifiedEntry` includes `start`/`length` in both `a` and `b`.
- "Leftovers go to newInB / removedFromB" → Task 1 Pass 2 closing loops.
- "Same-song same-boundary same-metadata different-clipId entries are skipped (no entry produced)" → Task 1 Pass 2: if `diffs.length === 0` after `computeDiffs`, no entry is pushed.
- "Frontend renders `clipBoundaries` as `start=N,len=N`" → Task 2 `renderFieldValue` helper.
- "`fieldLabel.clipBoundaries = "clip"`" → Task 2 Step 2.
- "Backend `findMany` includes `clip.songId`/`start`/`length`" → Task 1 Step 1.
- "`aClipId` added only for `songId`-paired entries" → Task 1 `buildModifiedEntry` `if (!sameClipId)` guard.

**Manual test plan items 1–10 from spec:** All map to either the smoke-test steps inside Task 1/2/4/6 or to the user's follow-up manual testing. Test item 10 (re-run the original bug-report diff and verify the four entries move from "Removed" to "Modified") is covered by Task 1 Step 4 once the user supplies their two IDs.

### 2. Placeholder scan

No "TBD", "TODO", "implement later", "add appropriate X", or "similar to Task N". Every code block is complete and copy-pasteable. The only deliberately-non-shown thing is the rest of the `i18n` files — Task 3 explicitly says the other keys are unchanged.

### 3. Type / name consistency

- `buildDiff(aRows, bRows)`: signature unchanged across the rewrite. Same callers, same shape (with additive fields).
- Modified entry: `clipId` (B-side) preserved; `aClipId` ADDED for `songId`-paired entries only; `a`/`b` now include `start` and `length` always. The frontend reads `row.a[field]` / `row.b[field]` so `start`/`length` are accessible without additional code, and the `renderFieldValue` helper handles `clipBoundaries` specifically.
- `fieldLabel.clipBoundaries = "clip"` (Task 2) matches the diff string `clipBoundaries` produced by `computeDiffs` (Task 1).
- i18n keys: `tools`, `navTools`, `toolsDiffDescription` (Task 3) match exactly the `t(...)` calls in Task 4 and Task 5.
- Navbar uses `t("navTools")` (Task 5); both i18n files have `navTools` (Task 3).
- `useRouter`, `useEffect`, `isDesktop` removed in Task 6 are the same names introduced when the diff overflow item was added (verified by reading current `PlaylistHeader.js`).

No inconsistencies.
