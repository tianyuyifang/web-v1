# Playlist Diff Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-directional playlist diff tool at `/tools/diff` that shows what changed in playlist B relative to baseline A (added/modified/removed clips), desktop/tablet only.

**Architecture:** New backend `GET /api/playlists/diff` route that loads both playlists, joins by `clipId`, and returns a structured payload. New frontend page at `/tools/diff` that reads `?a=&b=` from the URL and renders three sections. New reusable `PlaylistPicker` for selecting playlists by name. Phone (`<md`) gets a desktop-only notice and the menu/navbar entries are hidden.

**Tech Stack:** Express.js, Prisma (Postgres), Next.js 14 App Router, React 18, Tailwind CSS, plain JavaScript.

**Spec:** [`docs/superpowers/specs/2026-05-10-playlist-diff-tool-design.md`](../specs/2026-05-10-playlist-diff-tool-design.md)

---

## File Structure

**Backend (new code in existing file):**
- Modify: `backend/src/routes/playlists.js` — add `GET /diff` route mounted before `module.exports`, plus a local helper `buildDiff(aClips, bClips)` for the comparison logic.

**Frontend (new files):**
- Create: `frontend/src/app/tools/diff/page.js` — the page. Owns URL params, phone detection, API call, error state.
- Create: `frontend/src/components/tools/PlaylistPicker.js` — reusable autocomplete picker.
- Create: `frontend/src/components/tools/DiffReport.js` — renders the three diff sections.

**Frontend (modified):**
- Modify: `frontend/src/lib/api.js` — add `playlistsAPI.diff(aId, bId)`.
- Modify: `frontend/src/i18n/en.js` and `frontend/src/i18n/zh.js` — add 16 new keys.
- Modify: `frontend/src/components/layout/Navbar.js` — add "Diff" link in desktop nav row only.
- Modify: `frontend/src/components/playlist/PlaylistHeader.js` — add a "Diff" item to `overflowItems` gated on viewport.

**No tests.** Project has no automated test suite for either backend or frontend; verification is manual (spec test plan).

Tasks are ordered so each commit produces something self-consistent. Backend first (so the API exists when the frontend calls it), then API client + i18n (so the page has both keys and the client), then components (picker, report), then the page itself, then the entry points (navbar, overflow menu).

---

## Task 1: Backend diff route

**Files:**
- Modify: `backend/src/routes/playlists.js` (insert before the final `module.exports = router;` at line 641)

- [ ] **Step 1: Open the routes file and locate the insertion point**

Open `backend/src/routes/playlists.js`. Confirm line 641 reads `module.exports = router;`. The new route must be inserted directly above this line.

- [ ] **Step 2: Insert the diff route and helper**

Insert this block immediately before the `module.exports = router;` line:

```js
// ========================= Diff =========================

/**
 * Build a one-directional diff: B relative to A.
 * Inputs are arrays of playlistClip rows already including clip.song.
 * Returns { newInB, modifiedInB, removedFromB }.
 *
 * Comparison rules:
 *   - speed: numeric exact equality
 *   - colorTag: nullable string; null == null
 *   - comment: nullable string; null and "" treated as equal; trimmed
 *   - sectionLabel: nullable string; null and "" treated as equal; trimmed
 *   - position and pitch are NOT compared
 */
function buildDiff(aRows, bRows) {
  const normalize = (v) => {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  };
  const equalText = (x, y) => normalize(x) === normalize(y);

  const formatClip = (pc) => ({
    clipId: pc.clipId,
    song: { title: pc.clip.song.title, artist: pc.clip.song.artist },
    speed: pc.speed,
    colorTag: pc.colorTag,
    comment: pc.comment,
    sectionLabel: pc.sectionLabel,
  });

  const aMap = new Map();
  for (const pc of aRows) aMap.set(pc.clipId, pc);
  const bMap = new Map();
  for (const pc of bRows) bMap.set(pc.clipId, pc);

  const newInB = [];
  const modifiedInB = [];
  const removedFromB = [];

  for (const [clipId, bPc] of bMap) {
    if (!aMap.has(clipId)) {
      newInB.push(formatClip(bPc));
      continue;
    }
    const aPc = aMap.get(clipId);
    const diffs = [];
    if (aPc.speed !== bPc.speed) diffs.push('speed');
    if (normalize(aPc.colorTag) !== normalize(bPc.colorTag)) diffs.push('colorTag');
    if (!equalText(aPc.comment, bPc.comment)) diffs.push('comment');
    if (!equalText(aPc.sectionLabel, bPc.sectionLabel)) diffs.push('sectionLabel');
    if (diffs.length > 0) {
      modifiedInB.push({
        clipId,
        song: { title: bPc.clip.song.title, artist: bPc.clip.song.artist },
        a: {
          speed: aPc.speed,
          colorTag: aPc.colorTag,
          comment: aPc.comment,
          sectionLabel: aPc.sectionLabel,
        },
        b: {
          speed: bPc.speed,
          colorTag: bPc.colorTag,
          comment: bPc.comment,
          sectionLabel: bPc.sectionLabel,
        },
        diffs,
      });
    }
  }

  for (const [clipId, aPc] of aMap) {
    if (!bMap.has(clipId)) {
      removedFromB.push({
        clipId,
        song: { title: aPc.clip.song.title, artist: aPc.clip.song.artist },
      });
    }
  }

  return { newInB, modifiedInB, removedFromB };
}

// GET /api/playlists/diff?a=<uuid>&b=<uuid> — one-directional diff: B vs baseline A
router.get('/diff', async (req, res, next) => {
  try {
    const prisma = require('../db/client');
    const { a, b } = req.query;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!a || !b) {
      return res.status(400).json({ error: { message: 'Both a and b query parameters are required' } });
    }
    if (!UUID_RE.test(a) || !UUID_RE.test(b)) {
      return res.status(400).json({ error: { message: 'Invalid playlist ID format' } });
    }
    if (a === b) {
      return res.status(400).json({ error: { message: 'Cannot diff a playlist against itself' } });
    }

    const userId = req.user.id;
    const [aPl, bPl] = await Promise.all([
      prisma.playlist.findUnique({
        where: { id: a },
        include: {
          shares: { where: { userId }, select: { id: true }, take: 1 },
          copyPermissions: { where: { userId }, select: { id: true }, take: 1 },
        },
      }),
      prisma.playlist.findUnique({
        where: { id: b },
        include: {
          shares: { where: { userId }, select: { id: true }, take: 1 },
          copyPermissions: { where: { userId }, select: { id: true }, take: 1 },
        },
      }),
    ]);

    const canView = (pl) =>
      !!pl &&
      (pl.userId === userId ||
        pl.isPublic ||
        pl.shares.length > 0 ||
        pl.copyPermissions.length > 0);

    if (!canView(aPl) || !canView(bPl)) {
      return res.status(404).json({ error: { message: 'Playlist not found' } });
    }

    const [aClips, bClips] = await Promise.all([
      prisma.playlistClip.findMany({
        where: { playlistId: a },
        include: { clip: { select: { song: { select: { title: true, artist: true } } } } },
      }),
      prisma.playlistClip.findMany({
        where: { playlistId: b },
        include: { clip: { select: { song: { select: { title: true, artist: true } } } } },
      }),
    ]);

    const diff = buildDiff(aClips, bClips);
    res.json({
      a: { id: aPl.id, name: aPl.name },
      b: { id: bPl.id, name: bPl.name },
      ...diff,
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Restart the backend dev server**

Stop the running backend (`Ctrl-C` in its terminal, or `taskkill /F /IM node.exe` on Windows if detached). Then:

```
cd backend
npm run dev
```

Expected: server logs successful startup with no syntax errors.

- [ ] **Step 4: Smoke test the route**

In a browser devtools console on `http://localhost:3000` while logged in:

```js
fetch('/api/playlists/diff?a=<PLAYLIST_A_ID>&b=<PLAYLIST_B_ID>', {
  credentials: 'include',
}).then(r => r.json()).then(console.log);
```

Replace `<PLAYLIST_A_ID>` and `<PLAYLIST_B_ID>` with two playlists you own where B was copied from A.

Expected: a JSON response with the shape `{ a, b, newInB, modifiedInB, removedFromB }`. If B is an unmodified copy of A, all three arrays should be empty.

Then try:

```js
// Same id twice → 400
fetch('/api/playlists/diff?a=<ID>&b=<ID>', { credentials: 'include' })
  .then(r => r.json()).then(console.log);
// Missing param → 400
fetch('/api/playlists/diff?a=<ID>', { credentials: 'include' })
  .then(r => r.json()).then(console.log);
// Random nonexistent id → 404
fetch('/api/playlists/diff?a=00000000-0000-0000-0000-000000000000&b=<ID>', { credentials: 'include' })
  .then(r => r.json()).then(console.log);
```

Each call should return the expected status and error message.

- [ ] **Step 5: Commit**

```
git add backend/src/routes/playlists.js
git commit -m "Add GET /api/playlists/diff route"
```

---

## Task 2: API client

**Files:**
- Modify: `frontend/src/lib/api.js`

- [ ] **Step 1: Open the file and locate the playlistsAPI Compare block**

The Compare block currently lives around lines 160–168. Add the new `diff` method immediately after the existing Compare block, before the Shares block.

- [ ] **Step 2: Add the method**

Insert this snippet directly after the `compareWithInternal` line and the blank line that follows it (line 169 area):

```js
  // Diff
  diff: (aId, bId) => api.get(`/playlists/diff`, { params: { a: aId, b: bId } }),
```

After the edit, the surrounding context should read:

```js
  compareWithInternal: (id, targetPlaylistId) =>
    api.post(`/playlists/${id}/compare/internal`, { targetPlaylistId }),

  // Diff
  diff: (aId, bId) => api.get(`/playlists/diff`, { params: { a: aId, b: bId } }),

  // Shares
  getShares: (id) => api.get(`/playlists/${id}/shares`),
```

- [ ] **Step 3: Commit**

```
git add frontend/src/lib/api.js
git commit -m "Add playlistsAPI.diff client method"
```

---

## Task 3: i18n strings (English + Chinese)

**Files:**
- Modify: `frontend/src/i18n/en.js`
- Modify: `frontend/src/i18n/zh.js`

- [ ] **Step 1: Add English keys**

Open `frontend/src/i18n/en.js`. At the end of the object (before the final closing `};`), add a new section:

```js
  // Diff tool
  diff: "Diff",
  navDiff: "Diff",
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

- [ ] **Step 2: Add Chinese keys**

Open `frontend/src/i18n/zh.js`. Mirror the English keys in the same place (end of the object, before the closing `};`):

```js
  // 对比工具
  diff: "对比",
  navDiff: "对比",
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

- [ ] **Step 3: Commit**

```
git add frontend/src/i18n/en.js frontend/src/i18n/zh.js
git commit -m "Add i18n strings for playlist diff tool"
```

---

## Task 4: PlaylistPicker component

**Files:**
- Create: `frontend/src/components/tools/PlaylistPicker.js`

- [ ] **Step 1: Confirm target directory exists or create it**

Run from repo root `c:\Projects\web-v1`:

```
ls frontend/src/components/tools 2>NUL || mkdir -p frontend/src/components/tools
```

(If on PowerShell: `if (-not (Test-Path frontend/src/components/tools)) { New-Item -ItemType Directory -Path frontend/src/components/tools }`.)

Either way, ensure the directory exists.

- [ ] **Step 2: Write the picker component**

Create `frontend/src/components/tools/PlaylistPicker.js` with this content:

```jsx
"use client";

import { useEffect, useRef, useState } from "react";
import { playlistsAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";

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
export default function PlaylistPicker({ label, value, onChange, excludeId, placeholder }) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open || !query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await playlistsAPI.list({ q: query.trim() });
        const list = Array.isArray(res.data) ? res.data : res.data.playlists || [];
        setResults(list.filter((p) => p.id !== excludeId));
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, open, excludeId]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  if (value && !open) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">{label}</span>
        <span
          className="rounded-md bg-surface px-2 py-1 text-sm font-medium"
          style={{ color: "var(--text)" }}
        >
          {value.name}
        </span>
        <button
          type="button"
          onClick={() => {
            setQuery("");
            setOpen(true);
          }}
          className="text-xs text-primary hover:underline"
        >
          {t("diffChange")}
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <label className="mb-1 block text-sm text-muted">{label}</label>
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder || t("diffSelectPlaylist")}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
        style={{ color: "var(--text)" }}
      />
      {open && results.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-surface shadow-lg">
          {results.map((p) => (
            <li key={p.id}>
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```
git add frontend/src/components/tools/PlaylistPicker.js
git commit -m "Add PlaylistPicker component"
```

---

## Task 5: DiffReport component

**Files:**
- Create: `frontend/src/components/tools/DiffReport.js`

- [ ] **Step 1: Write the report component**

Create `frontend/src/components/tools/DiffReport.js` with this content:

```jsx
"use client";

import { useLanguage } from "@/components/layout/LanguageProvider";

function formatValue(v) {
  if (v === null || v === undefined || v === "") return "(empty)";
  return String(v);
}

function MetadataLine({ speed, colorTag, comment, sectionLabel }) {
  return (
    <div className="text-xs text-muted">
      speed {speed}
      {colorTag ? ` · tag ${colorTag}` : ""}
      {comment ? ` · 💬` : ""}
      {sectionLabel ? ` · §${sectionLabel}` : ""}
    </div>
  );
}

function Section({ titleKey, emptyKey, count, children }) {
  const { t } = useLanguage();
  return (
    <section className="mb-6 rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-3 text-base font-semibold" style={{ color: "var(--text)" }}>
        {t(titleKey)} <span className="text-muted">({count})</span>
      </h2>
      {count === 0 ? (
        <div className="text-sm text-muted">{t(emptyKey)}</div>
      ) : (
        <div className="space-y-2">{children}</div>
      )}
    </section>
  );
}

export default function DiffReport({ report }) {
  const { t } = useLanguage();

  const summary = t("diffSummary")
    .replace("{n}", report.newInB.length)
    .replace("{m}", report.modifiedInB.length)
    .replace("{k}", report.removedFromB.length);

  const fieldLabel = {
    speed: "speed",
    colorTag: "tag",
    comment: "comment",
    sectionLabel: "section",
  };

  return (
    <div>
      <p className="mb-4 text-sm text-muted">{summary}</p>

      <Section titleKey="diffNewInB" emptyKey="diffNoNew" count={report.newInB.length}>
        {report.newInB.map((row) => (
          <div key={row.clipId} className="rounded-md bg-background p-2">
            <div className="text-sm font-medium" style={{ color: "var(--text)" }}>
              {row.song.title} — <span className="text-muted">{row.song.artist}</span>
            </div>
            <MetadataLine
              speed={row.speed}
              colorTag={row.colorTag}
              comment={row.comment}
              sectionLabel={row.sectionLabel}
            />
          </div>
        ))}
      </Section>

      <Section titleKey="diffModifiedInB" emptyKey="diffNoModified" count={report.modifiedInB.length}>
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
      </Section>

      <Section titleKey="diffRemovedFromB" emptyKey="diffNoRemoved" count={report.removedFromB.length}>
        {report.removedFromB.map((row) => (
          <div key={row.clipId} className="rounded-md bg-background p-2">
            <div className="text-sm font-medium" style={{ color: "var(--text)" }}>
              {row.song.title} — <span className="text-muted">{row.song.artist}</span>
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```
git add frontend/src/components/tools/DiffReport.js
git commit -m "Add DiffReport component"
```

---

## Task 6: Diff page (`/tools/diff`)

**Files:**
- Create: `frontend/src/app/tools/diff/page.js`

- [ ] **Step 1: Confirm target directory or create it**

Run from repo root:

```
ls frontend/src/app/tools 2>NUL
```

If absent (likely), create:

```
mkdir -p frontend/src/app/tools/diff
```

- [ ] **Step 2: Write the page**

Create `frontend/src/app/tools/diff/page.js` with this content:

```jsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { playlistsAPI } from "@/lib/api";
import { useLanguage } from "@/components/layout/LanguageProvider";
import PlaylistPicker from "@/components/tools/PlaylistPicker";
import DiffReport from "@/components/tools/DiffReport";

export default function DiffPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();
  const aId = searchParams.get("a");
  const bId = searchParams.get("b");

  const [aPlaylist, setAPlaylist] = useState(null); // { id, name } | null
  const [bPlaylist, setBPlaylist] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);

  // Detect viewport on mount; ignore SSR
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // When URL has a/b, fetch playlist names so the pickers show the selected state on first load.
  useEffect(() => {
    let cancelled = false;
    async function fetchName(id, setter) {
      if (!id) {
        setter(null);
        return;
      }
      try {
        const res = await playlistsAPI.getById(id);
        if (!cancelled) setter({ id: res.data.id, name: res.data.name });
      } catch {
        if (!cancelled) setter(null);
      }
    }
    fetchName(aId, setAPlaylist);
    fetchName(bId, setBPlaylist);
    return () => {
      cancelled = true;
    };
  }, [aId, bId]);

  // When both URL ids are set, fetch the diff
  useEffect(() => {
    let cancelled = false;
    if (!aId || !bId) {
      setReport(null);
      setError("");
      return;
    }
    if (aId === bId) {
      setReport(null);
      setError(t("diffSameError"));
      return;
    }
    setLoading(true);
    setError("");
    setReport(null);
    playlistsAPI
      .diff(aId, bId)
      .then((res) => {
        if (!cancelled) setReport(res.data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.response?.data?.error?.message || "Failed to load diff");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aId, bId, t]);

  const updateUrl = useCallback(
    (newA, newB) => {
      const params = new URLSearchParams();
      if (newA) params.set("a", newA);
      if (newB) params.set("b", newB);
      const qs = params.toString();
      router.replace(qs ? `/tools/diff?${qs}` : "/tools/diff");
    },
    [router]
  );

  const handleSelectA = (p) => {
    setAPlaylist(p);
    updateUrl(p?.id || null, bId);
  };
  const handleSelectB = (p) => {
    setBPlaylist(p);
    updateUrl(aId, p?.id || null);
  };
  const handleSwap = () => {
    updateUrl(bId, aId);
  };

  if (!isDesktop) {
    return (
      <main className="mx-auto max-w-screen-md p-6">
        <p className="text-center text-muted">{t("diffDesktopOnly")}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-screen-lg p-6">
      <h1 className="mb-4 text-2xl font-bold" style={{ color: "var(--text)" }}>
        {t("diff")}
      </h1>

      <div className="mb-6 space-y-3 rounded-lg border border-border bg-surface p-4">
        <PlaylistPicker
          label={t("diffBaseline")}
          value={aPlaylist}
          onChange={handleSelectA}
          excludeId={bId || undefined}
        />
        <PlaylistPicker
          label={t("diffCurrent")}
          value={bPlaylist}
          onChange={handleSelectB}
          excludeId={aId || undefined}
        />
        {aId && bId && (
          <div>
            <button
              type="button"
              onClick={handleSwap}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-hover"
              style={{ color: "var(--text)" }}
            >
              {t("diffSwap")}
            </button>
          </div>
        )}
      </div>

      {!aId || !bId ? (
        <p className="text-sm text-muted">{t("diffEmpty")}</p>
      ) : loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : report ? (
        <DiffReport report={report} />
      ) : null}
    </main>
  );
}
```

- [ ] **Step 3: Commit**

```
git add frontend/src/app/tools/diff/page.js
git commit -m "Add /tools/diff page"
```

---

## Task 7: Navbar entry

**Files:**
- Modify: `frontend/src/components/layout/Navbar.js`

- [ ] **Step 1: Add the "Diff" link to the desktop nav row**

In `frontend/src/components/layout/Navbar.js`, locate the desktop nav row (currently lines 72–84 — the `<div className="hidden items-center gap-1 md:flex">` block). Insert a new `navLink` for diff between Playlists and Guide.

Before:

```jsx
            <div className="hidden items-center gap-1 md:flex">
              {navLink("/playlists", t("navPlaylists"))}
              {navLink("/guide", t("navGuide"))}
              {navLink("/feedback", t("navFeedback"))}
              {isAdmin && navLink("/admin", t("navAdmin"))}
              {navLink("/settings", t("navSettings"))}
```

After:

```jsx
            <div className="hidden items-center gap-1 md:flex">
              {navLink("/playlists", t("navPlaylists"))}
              {navLink("/tools/diff", t("navDiff"))}
              {navLink("/guide", t("navGuide"))}
              {navLink("/feedback", t("navFeedback"))}
              {isAdmin && navLink("/admin", t("navAdmin"))}
              {navLink("/settings", t("navSettings"))}
```

Only the desktop row gets the new link. Do NOT add it to the mobile dropdown (the second `<div>` near line 104). This implements the desktop-only requirement at the navbar level.

- [ ] **Step 2: Commit**

```
git add frontend/src/components/layout/Navbar.js
git commit -m "Add Diff link to desktop navbar"
```

---

## Task 8: Playlist overflow menu entry

**Files:**
- Modify: `frontend/src/components/playlist/PlaylistHeader.js`

- [ ] **Step 1: Import `useEffect` (already imported via `useState`) — confirm and add useRouter**

Check the top of `frontend/src/components/playlist/PlaylistHeader.js`. The current imports include `useState` from React. Add `useEffect` to the same line, and add `useRouter` from `next/navigation`.

Before:

```jsx
import { useState } from "react";
```

After:

```jsx
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
```

(`next/navigation` is already used elsewhere in the app and is available in client components.)

- [ ] **Step 2: Add desktop detection state**

Inside the `PlaylistHeader` component body, after the existing `useState` calls for `editName` and `editDesc`, add a `useState` + `useEffect` for `isDesktop`, and a `router`:

Before (the existing two useState lines near line 36–37 of the current file):

```jsx
  const [editName, setEditName] = useState(playlist.name);
  const [editDesc, setEditDesc] = useState(playlist.description || "");
```

After (add the `router` line above and the `isDesktop` block below):

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

- [ ] **Step 3: Add the Diff item to `overflowItems`**

Locate the `overflowItems` array (the one that includes `share`, `autoplay`, `compare`, `compact`, `public`). Append a new item AFTER `compare` (so order is: Share, AutoPlay, Compare, Diff, Compact, Public):

Before the change, the `compare` entry reads:

```jsx
    {
      id: "compare",
      label: t("comparePlaylist"),
      onClick: () => onCompare?.(),
      hidden: editMode,
    },
```

After it, insert:

```jsx
    {
      id: "diff",
      label: t("diff"),
      onClick: () => router.push(`/tools/diff?b=${playlist.id}`),
      hidden: editMode || !isDesktop,
    },
```

Result: the Diff item appears in the overflow menu only when (a) the user is not in edit mode AND (b) the viewport is `md+`. Clicking it navigates to the diff page with the current playlist pre-filled as B.

- [ ] **Step 4: Smoke test the dev server compile**

In the frontend dev server terminal, watch for a successful HMR recompile after saving. No errors expected.

- [ ] **Step 5: Commit**

```
git add frontend/src/components/playlist/PlaylistHeader.js
git commit -m "Add Diff entry to playlist overflow menu"
```

---

## Task 9: Manual verification

This task is for the human. The subagent cannot run a browser session.

- [ ] **Step 1: Smoke test on desktop**

With both `cd backend && npm run dev` and `cd frontend && npm run dev` running, log in. Visit `/tools/diff`. Confirm:

- Two empty pickers labeled Baseline (A) and Current (B).
- Typing in a picker searches and shows matching playlists.
- Selecting one updates the input to show the playlist name + "change" link.
- The other picker excludes the already-chosen playlist from its results.

- [ ] **Step 2: Verify diff content**

Pick playlist A. Copy A using the existing Copy feature so you have B = "Copy of A". Modify B: change one clip's speed, color tag, and comment; add one new clip from another song; remove one clip. Now visit `/tools/diff?a=<A>&b=<B>` (or pick both manually). Confirm:

- "New in current" lists the added clip.
- "Modified in current" lists the changed clip with the right diffs (`speed`, `colorTag`, `comment`).
- "Removed from current" lists the deleted clip.
- Reordering clips in B does NOT show as a change.
- Changing pitch only does NOT show as a change.

- [ ] **Step 3: Verify entry points**

- From a playlist's overflow menu on desktop, click "Diff". URL should be `/tools/diff?b=<id>`, B pre-filled.
- Navbar: "Diff" link visible between Playlists and Guide.

- [ ] **Step 4: Phone behavior**

Resize the window to <768px wide (or use devtools mobile emulation):

- Navbar mobile menu: "Diff" NOT present.
- Playlist overflow menu: "Diff" NOT present.
- Direct visit to `/tools/diff?a=<A>&b=<B>`: shows only the "Diff is only available on tablet or desktop." notice.

- [ ] **Step 5: Error paths**

- `/tools/diff?a=<X>&b=<X>` → "Cannot diff a playlist against itself" message.
- `/tools/diff?a=<X>&b=00000000-0000-0000-0000-000000000000` → "Playlist not found" error.
- Sign in as a different user with no access to A or B, visit the URL → same 404 error.

---

## Self-Review

### 1. Spec coverage

- **Goal "one-directional diff B vs A":** Task 1 `buildDiff` implements exactly this.
- **Path `/tools/diff` with optional `?a=&b=`:** Task 6 page reads both from `searchParams`.
- **Phone (`<md`) hidden:** Task 8 (overflow menu) and Task 7 (navbar) implement the gating. Task 6 page shows the desktop-only notice.
- **Entry points (navbar + overflow menu):** Tasks 7 and 8.
- **Pickers + Swap:** Task 6 page uses two `PlaylistPicker`s and has a Swap button when both are selected.
- **Three sections, fixed order New → Modified → Removed:** Task 5 `DiffReport` renders them in that order. Each section shows count and empty-state.
- **Definition of "same clip" = `clip.id`:** Task 1 `buildDiff` joins by `clipId`.
- **Compared fields = speed, colorTag, comment, sectionLabel:** Task 1 `buildDiff` compares exactly these four. Position and pitch are intentionally absent.
- **Backend route `GET /api/playlists/diff?a=&b=` with auth + 404/400 errors:** Task 1.
- **Response shape `{ a, b, newInB, modifiedInB, removedFromB }`:** Task 1 route returns it; Task 5 `DiffReport` consumes it.
- **`removedFromB` lists only song identity (no metadata):** Task 1 `buildDiff` formats removed rows with only `clipId` + `song`.
- **i18n keys:** Task 3 adds all keys from the spec table, in both languages. (The spec lists 15 keys; the plan adds 16 — one extra is `navDiff`, used by the navbar entry. `diff` is used by the overflow menu item and the page heading.)
- **Frontend split: page / picker / report:** Tasks 4, 5, 6.
- **API client `playlistsAPI.diff`:** Task 2.
- **Comparison rules — speed exact, color null-equals-null, comment/sectionLabel null≡"" with trim:** Task 1 `buildDiff` implements all four explicitly.
- **Self-diff blocked at API:** Task 1 returns 400 when `a === b`. Page also short-circuits with `diffSameError` in Task 6 (defensive duplication is fine here — keeps the UX snappy without a roundtrip).
- **Manual test plan items 1–15 from spec:** Covered in Task 9 (split across Steps 1–5).

Spec is fully covered.

### 2. Placeholder scan

No "TBD", "TODO", "implement later", "add appropriate X", "similar to Task N", or vague code blocks. Every code block is complete and copy-pasteable. The only unspecified text is the "Loading…" string in Task 6 — that's intentionally not internationalized because it's transient and there's no precedent for a `loading` key in the existing i18n files; if the reviewer prefers, this can be added in a one-line follow-up.

### 3. Type / name consistency

- Route: `GET /api/playlists/diff` (Task 1) ↔ `api.get('/playlists/diff', { params: { a, b } })` in client (Task 2). Consistent.
- Response keys `newInB`, `modifiedInB`, `removedFromB` ↔ used in `DiffReport` (Task 5) and counted in `diffSummary` (Task 6, via Task 5). Consistent.
- Per-row keys: backend emits `clipId`, `song.{title,artist}`, `speed`, `colorTag`, `comment`, `sectionLabel`, `a`, `b`, `diffs` — all consumed by `DiffReport`. Consistent.
- `PlaylistPicker` props (`label`, `value`, `onChange`, `excludeId`, `placeholder`) — Task 4 defines them, Task 6 uses `label`, `value`, `onChange`, `excludeId` (no override of `placeholder`, falls back to `t("diffSelectPlaylist")`). Consistent.
- `playlist.list({ q })` response shape (array vs `{ playlists }` object): Task 4 handles both with `Array.isArray(res.data) ? res.data : res.data.playlists || []` — same pattern used in the existing `ComparePlaylistModal.js`. Consistent with codebase.
- `useLanguage().t(key)`: every key referenced (`diff`, `navDiff`, `diffBaseline`, `diffCurrent`, `diffSwap`, `diffChange`, `diffSelectPlaylist`, `diffNewInB`, `diffModifiedInB`, `diffRemovedFromB`, `diffNoNew`, `diffNoModified`, `diffNoRemoved`, `diffSummary`, `diffDesktopOnly`, `diffSameError`, `diffEmpty`) is added in Task 3 to both `en.js` and `zh.js`. The `comparePlaylist` key already exists. Consistent.
- `isDesktop` viewport check: Task 6 (page) and Task 8 (header overflow) use the same `window.matchMedia('(min-width: 768px)')` check, matching the navbar's existing `md:` breakpoint. Consistent.

No inconsistencies.
