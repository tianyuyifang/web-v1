# Playlist Diff Tool — design

## Goal

Provide a one-directional diff between two playlists. Given a baseline `A` and a current `B`, show what changed in `B` compared to `A`: clips added, clips modified, clips removed. Position is ignored, pitch is ignored.

Use case: a user copies playlist A into B and edits B over time. The diff lets them see exactly what they've changed.

## Scope

- New page at `/tools/diff`.
- New backend route returning a structured diff payload.
- Desktop and tablet only (`md+` breakpoint). Phone (`<md`) does not get the menu item, navbar link, or the page UI — phone users who reach the URL directly see a desktop-only notice.
- Read-only: no editing from the diff page.

## Page

### Path and parameters

- `/tools/diff` — empty page, two pickers shown.
- `/tools/diff?a=<id>&b=<id>` — both selected, diff loads.
- `/tools/diff?b=<id>` — `B` pre-filled (used when entering from a playlist's overflow menu); user picks `A`.

URL is the source of truth. Changing pickers updates the URL via `router.replace` (no history entry per keystroke; the picker fires on selection, not typing).

### Entry points

1. **Navbar** — new link "Diff" between "Playlists" and "Guide", visible only on `md+`. Hidden on phone via Tailwind `md:flex` (existing navbar pattern).
2. **Playlist overflow menu** — new "Diff" item on the playlist detail page. Hidden on phone (`md+` only). Selecting it navigates to `/tools/diff?b=<currentPlaylistId>`.

### Phone behavior

- Navbar link: hidden by `md:flex` on the desktop nav row; not added to the mobile dropdown.
- Overflow menu item: hidden when viewport is `<md`. Implementation: a CSS media query is impractical inside an array of menu items, so we add a runtime check (`window.matchMedia('(min-width: 768px)').matches`) in `PlaylistHeader` and pass `hidden: !isDesktop` on the diff overflow item.
- Direct visit to `/tools/diff` on phone: the page renders a centered notice "Diff is only available on tablet or desktop." and nothing else.

The page detects phone size via the same `window.matchMedia('(min-width: 768px)')`. The check runs in a `useEffect` (so SSR doesn't crash) with a default of `true` (assume desktop) until mounted.

### Layout (when both A and B are selected)

```
┌──────────────────────────────────────────────────────────────────┐
│ Diff                                                             │
│                                                                  │
│  Baseline (A): [B♥] Songs of Summer (selected)   [change]        │
│  Current  (B): [B♥] Songs of Summer v2 (selected) [change] [swap]│
│                                                                  │
│  Summary: 3 new · 2 modified · 1 removed                         │
│                                                                  │
│  ┌─ New in current ─────────────────────────────────────────┐    │
│  │ Title — Artist                                           │    │
│  │   speed 1.0 · tag ● · 💬 (if comment) · §section         │    │
│  └──────────────────────────────────────────────────────────┘    │
│  ┌─ Modified in current ────────────────────────────────────┐    │
│  │ Title — Artist                                           │    │
│  │   speed: 1.0 → 1.25                                      │    │
│  │   tag:   red → blue                                      │    │
│  │   comment: (empty) → "fav"                               │    │
│  │   section: (empty) → "chorus"                            │    │
│  └──────────────────────────────────────────────────────────┘    │
│  ┌─ Removed from current ───────────────────────────────────┐    │
│  │ Title — Artist                                           │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

Section header shows count. Empty sections render their header + empty-state text ("No new clips" / "No modifications" / "No removed clips").

Section order is fixed: New → Modified → Removed.

### Pickers

The `A` and `B` rows each contain a search-and-select component (`PlaylistPicker`). Behavior:

- Empty state: search input with placeholder.
- Typing: debounced (300 ms) search against `playlistsAPI.list({ q })`, results render below the input as a clickable list, excluding the other side's currently-selected playlist.
- After selection: input collapses into a "selected" pill showing the playlist name and a "change" link that re-opens the search input.

The autocomplete behavior is extracted from the existing internal-compare path in `ComparePlaylistModal.js` (lines 16–39). We copy that pattern into the new `PlaylistPicker` component rather than refactoring `ComparePlaylistModal` (out of scope; keeps the change focused).

"Swap" reverses `A` and `B` and updates the URL.

## Backend

### Route

```
GET /api/playlists/diff?a=<uuid>&b=<uuid>
```

`GET` because the operation is read-only, idempotent, and the IDs fit comfortably in the URL. Both query params are required.

### Access control

Both `A` and `B` must be viewable by the caller:

- Owner, OR
- `playlist.isPublic`, OR
- An entry in `playlist.shares` for the caller, OR
- An entry in `playlist.copyPermissions` for the caller

If either side is not viewable, return `404` with the standard error shape (matches the existing internal-compare route's "Playlist not found" behavior).

### Comparison logic

1. Load all `playlistClip` rows for `A` and `B`, each with `clipId`, `speed`, `colorTag`, `comment`, `sectionLabel`, and the underlying song's `id`, `title`, `artist`.
2. Build a map keyed by `clipId` for each side. (Each `(playlistId, clipId)` is unique — see `PlaylistClip` schema.)
3. For each `clipId` in `A`'s map:
   - If absent from `B` → `removedFromB`.
   - If present in `B` → compare the four metadata fields; if any differs, push to `modifiedInB`.
4. For each `clipId` in `B`'s map not in `A`'s map → `newInB`.

Comparison rules:

- `speed`: numeric equality (the schema stores it as `Float`; we compare exact values, no epsilon — speed is set from a discrete control).
- `colorTag`: nullable string. `null` equals `null`. `null` vs `"red"` is a diff.
- `comment`: nullable string. Trim and treat `null` and `""` as equivalent. `"hi"` vs `"hi "` is NOT a diff (trimmed comparison).
- `sectionLabel`: nullable string. Same null/empty-equivalent handling as `comment`. Trimmed comparison.
- `position`: not compared.
- `pitch`: not compared.

### Response shape

```json
{
  "a": { "id": "uuid", "name": "..." },
  "b": { "id": "uuid", "name": "..." },
  "newInB": [
    {
      "clipId": "uuid",
      "song": { "title": "...", "artist": "..." },
      "speed": 1.0,
      "colorTag": "red",
      "comment": "...",
      "sectionLabel": "..."
    }
  ],
  "modifiedInB": [
    {
      "clipId": "uuid",
      "song": { "title": "...", "artist": "..." },
      "a": { "speed": 1.0, "colorTag": null, "comment": null, "sectionLabel": null },
      "b": { "speed": 1.25, "colorTag": "blue", "comment": "fav", "sectionLabel": null },
      "diffs": ["speed", "colorTag", "comment"]
    }
  ],
  "removedFromB": [
    {
      "clipId": "uuid",
      "song": { "title": "...", "artist": "..." }
    }
  ]
}
```

`removedFromB` only includes the song identity (no metadata) because rendering before-values for a clip the user has deleted isn't actionable.

### Errors

- Missing or malformed `a`/`b` query params: `400` `{ error: { message: "Both a and b query parameters are required" } }` (or similar validation message).
- Either playlist not found or not viewable: `404` `{ error: { message: "Playlist not found" } }`.
- `a === b`: `400` `{ error: { message: "Cannot diff a playlist against itself" } }`.

## Frontend structure

- `frontend/src/app/tools/diff/page.js` — the page; handles URL params, phone detection, loading state, and composes the two pickers + the diff report.
- `frontend/src/components/tools/PlaylistPicker.js` — reusable autocomplete picker (`value`, `onChange`, `excludeId`, `placeholder` props).
- `frontend/src/components/tools/DiffReport.js` — renders the three sections (`newInB`, `modifiedInB`, `removedFromB`); receives the API payload as a prop.
- `frontend/src/lib/api.js` — add `playlistsAPI.diff(aId, bId)` calling `GET /api/playlists/diff?a=...&b=...`.
- `frontend/src/components/layout/Navbar.js` — add a "Diff" link between "Playlists" and "Guide" on the desktop nav row only.
- `frontend/src/components/playlist/PlaylistHeader.js` — add a "Diff" item to `overflowItems` with `hidden` flag tied to viewport size.

Splitting `PlaylistPicker` and `DiffReport` out of the page keeps each file focused. The page owns URL/state; the picker owns search; the report owns presentation.

## i18n

New keys in both `frontend/src/i18n/en.js` and `frontend/src/i18n/zh.js`:

| Key | English | Chinese |
|---|---|---|
| `diff` | Diff | 对比 |
| `diffBaseline` | Baseline (A) | 原始列表 A |
| `diffCurrent` | Current (B) | 当前列表 B |
| `diffSwap` | Swap | 交换 |
| `diffChange` | change | 更换 |
| `diffSelectPlaylist` | Search for a playlist… | 搜索列表… |
| `diffNewInB` | New in current | 新增 |
| `diffModifiedInB` | Modified in current | 已修改 |
| `diffRemovedFromB` | Removed from current | 已删除 |
| `diffNoNew` | No new clips | 没有新增片段 |
| `diffNoModified` | No modifications | 没有修改 |
| `diffNoRemoved` | No removed clips | 没有删除片段 |
| `diffSummary` | {n} new · {m} modified · {k} removed | 新增 {n} · 修改 {m} · 删除 {k} |
| `diffDesktopOnly` | Diff is only available on tablet or desktop. | 对比功能仅在平板或桌面端可用 |
| `diffSameError` | Cannot diff a playlist against itself | 无法和自身对比 |
| `diffEmpty` | Pick two playlists to compare. | 请选择两个列表进行对比 |

`diffSummary` uses simple `{n}`/`{m}`/`{k}` substitution; the existing `t()` API in this codebase returns plain strings, so the page handles substitution by `String.replace`.

## Out of scope

- Editing from the diff page (no "apply this change" buttons).
- Bi-directional or 3-way diff.
- Pitch comparison.
- Phone UI.
- Diffing a playlist against an external source (QQ/Netease/Kugou).
- Persistent diff history or copy-lineage tracking.
- A general "tools" hub page; only the diff tool lives under `/tools` for now.

## Manual test plan

1. **Empty page.** Visit `/tools/diff` directly with no query params. Expect: empty page with two pickers labelled Baseline (A) and Current (B), summary line absent.
2. **Select both.** Pick A then B. URL updates to `/tools/diff?a=<A>&b=<B>`. Diff loads.
3. **New clip detection.** Add a clip to B that's not in A. Refresh diff. The clip appears under "New in current" with its current metadata.
4. **Modified clip detection.** Change a clip's `speed`, `colorTag`, `comment`, or `sectionLabel` in B. Refresh. The clip appears under "Modified in current" with the correct before-after pair and the `diffs` array reflecting which fields changed.
5. **Removed clip detection.** Delete a clip from B that was in A. Refresh. The clip appears under "Removed from current".
6. **Position ignored.** Reorder clips in B without other changes. Refresh. The diff shows zero changes.
7. **Pitch ignored.** Change only `pitch` on a clip in B. Refresh. The diff shows zero changes.
8. **Swap.** Click swap. A and B swap; URL params swap; diff reloads from the other direction.
9. **Entry from playlist.** From a playlist's overflow menu on desktop, click "Diff". Lands on `/tools/diff?b=<currentPlaylistId>` with B pre-filled and A empty.
10. **Phone navbar.** Resize to `<md`. The "Diff" link is not in the mobile dropdown.
11. **Phone overflow menu.** On phone, open a playlist's overflow menu. There is no "Diff" entry.
12. **Phone direct visit.** Resize to `<md` and visit `/tools/diff?a=<A>&b=<B>`. Page shows only the "Diff is only available on tablet or desktop." notice.
13. **Access denied.** Sign in as a user who can't view A. Visit `/tools/diff?a=<A>&b=<B>`. API returns 404; page shows an error message.
14. **Self-diff blocked.** Set both pickers to the same playlist. API returns 400; page shows the "Cannot diff a playlist against itself" message.
15. **Same playlist content, identical metadata.** Diff a playlist against itself via two different IDs (e.g. copy A → B with no changes). All three sections are empty; summary reads "0 new · 0 modified · 0 removed".
