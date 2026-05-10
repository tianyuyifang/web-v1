# Tools hub + diff matching refinement — design

This spec bundles two related changes:

1. **Tools hub** — replace the direct "Diff" entry points with a `/tools` hub page, and remove the contextual entry from the playlist overflow menu.
2. **Diff matching refinement** — improve the diff comparison so that two playlist entries that share the same song but have different clip boundaries (start/length) are treated as a modification rather than a removal + addition.

The two changes ship together because they touch overlapping files (the diff page, the playlist header, the navbar) and share manual-test surface.

---

## Part 1 — Tools hub

### Goal
Treat `/tools` as a hub for future utilities. Today, it lists exactly one tool — Diff. Adding new tools later means a new tile, not a new top-level route or new navbar item.

### Pages

- New page: `/tools` — a hub showing one tile per available tool. Initial content: a single "Diff" tile linking to `/tools/diff`. The tile shows tool name (`t("diff")`) and a one-line description (`t("toolsDiffDescription")`).
- Existing page: `/tools/diff` — unchanged behavior. Still accessible via direct URL and bookmarkable.

### Navbar

- Remove the "Diff" link.
- Add a "Tools" link in the same position (between "Playlists" and "Guide"), desktop-only (same `md:flex` gating).

### Playlist overflow menu

Remove the `diff` item from `overflowItems` in `PlaylistHeader.js` entirely. The `isDesktop` viewport detection and `useRouter` import added when the menu entry was introduced stay (no harm leaving dead-code-free; they were added for the diff item and have no other user). **Cleanup:** remove the `isDesktop` state, the `useEffect` that listens to `matchMedia`, the `useRouter` import, and the `useEffect` React import (if no other usage). Drop them along with the menu item.

### i18n (new keys)

| Key | English | Chinese |
|---|---|---|
| `navTools` | Tools | 工具 |
| `tools` | Tools | 工具 |
| `toolsDiffDescription` | Compare a baseline playlist against a current one and see what changed. | 对比两个列表，查看片段差异。 |

Existing keys re-used: `diff` (tile title), `diffDesktopOnly` (still applies on the diff page).

The existing keys `navDiff` and `diff` stay in the i18n files even though `navDiff` is no longer referenced (low cost; if removed, it would have to be re-added later). **Cleanup:** remove `navDiff` from both files since it has no remaining consumer.

### Phone behavior on the hub

The `/tools` page itself does NOT need phone-only gating — it's a thin hub with no tool-specific UI. Phone users who land there see the list of tools, can tap "Diff", and then the `/tools/diff` page itself shows the existing "Diff is only available on tablet or desktop." notice. This is simpler than re-implementing the desktop-only gate at the hub level.

### File changes summary (Part 1)

- Create: `frontend/src/app/tools/page.js` — the hub page.
- Modify: `frontend/src/components/layout/Navbar.js` — swap the navbar entry from `/tools/diff`/`navDiff` → `/tools`/`navTools`.
- Modify: `frontend/src/components/playlist/PlaylistHeader.js` — remove the diff overflow item and the dead viewport detection + router import.
- Modify: `frontend/src/i18n/en.js` and `frontend/src/i18n/zh.js` — add `navTools`, `tools`, `toolsDiffDescription`; remove `navDiff`.

---

## Part 2 — Diff matching refinement

### Problem

The current `buildDiff` matches clips by `clip.id` only. When two playlists contain the same song but with different clip boundaries (different `start` or `length` on `Clip`), the rows show as one entry in "Removed from current" (the A clip) and another in "New in current" (the B clip). For the original use case (B is a copy of A that the user has edited), this rarely matters. For the general case of comparing two unrelated playlists that happen to share songs, it is confusing.

Observed example: comparing playlist A (徐良 list with 105 clips) against playlist B (different user's 徐良 list with 131 clips). Four entries land in "removed from B" — but for each, B has a clip of the same song at a different start time, so the user expected "modified", not "removed + new".

### Solution: Option C — hybrid matching

1. First pass: pair clips by `clip.id`. Same matching rule as today. Anything that matches goes through the metadata comparison; differing rows go to `modifiedInB`, same rows are dropped.
2. Second pass: for the remaining unmatched rows on both sides, build a map from `clip.songId` → list of rows. For each `songId` present in both maps, pair them up (one A row to one B row, in order, until one side runs out). Each pair becomes a `modifiedInB` entry with one additional comparison field: `clipBoundaries` (the start/length pair). The metadata-fields comparison still runs on speed, colorTag, comment, sectionLabel.
3. Whatever is left on the B side (no `clipId` match AND no `songId` partner remaining) → `newInB`.
4. Whatever is left on the A side → `removedFromB`.

#### Why "in order"?

If A has two clips of the same song and B also has two clips of the same song, we need a way to pair them. Two simple options:

- **A.** Pair by position order — A's first clip of that song pairs with B's first clip, A's second with B's second.
- **B.** Pair by closest `start` — minimize total `|aStart - bStart|`.

Option A is dumb but predictable and cheap. Option B is more accurate but adds complexity for a rare case (multiple clips of the same song in one playlist).

**Decision:** Option A. The `findMany` calls already use `orderBy: { position: 'asc' }`, so the order is stable. If a user has multiple clips of the same song this might pair them oddly, but the diff is still useful and the alternative (combinatorial matching) is not worth the code.

### Comparison rule for the new `clipBoundaries` field

A modified-by-song-match entry has `diffs: ["clipBoundaries", ...metadataDiffs]`. The `a` and `b` payload gains two extra fields:

```json
{
  "clipId": "<bClipId>",         // the B-side clipId, since this row is "in B"
  "aClipId": "<aClipId>",         // expose A's clipId too so the UI can show it changed
  "song": { "title": "...", "artist": "..." },
  "a": { "start": 30, "length": 20, "speed": 1.0, "colorTag": null, "comment": null, "sectionLabel": null },
  "b": { "start": 59, "length": 20, "speed": 1.0, "colorTag": null, "comment": null, "sectionLabel": null },
  "diffs": ["clipBoundaries"]
}
```

The `start` and `length` come from `clip.start` and `clip.length`. They are folded into the `a` and `b` objects under their own keys (not nested under `clipBoundaries`) — simpler to render.

`clipBoundaries` is detected as a difference when *either* `start` or `length` differs.

For the original same-`clipId` path, `start` and `length` are by definition equal (it's the same `Clip` row), so `clipBoundaries` is never in the `diffs` array for those rows. We still include `start` and `length` in `a` and `b` for those rows for shape consistency.

### Frontend rendering

In `DiffReport.js`, the field-label map gains one entry:

```js
const fieldLabel = {
  speed: "speed",
  colorTag: "tag",
  comment: "comment",
  sectionLabel: "section",
  clipBoundaries: "clip",
};
```

When the field is `clipBoundaries`, the displayed value is `start=<n>,len=<n>` rather than the raw number. The component already iterates `row.diffs.map((field) => ...)` and reads `row.a[field]` / `row.b[field]` — we need a small change so that `field === "clipBoundaries"` reads `row.a.start`/`row.a.length` and formats the pair. Implementation detail: add a helper `formatFieldValue(field, side)` that switches on `field` and pulls the right keys.

### Backend signature change

The route response shape grows. Specifically:

- Each `modifiedInB[]` entry's `a` and `b` objects now include `start` and `length` fields.
- Each `modifiedInB[]` entry may include an `aClipId` field (only when paired via the `songId` fallback). When matched via `clipId`, `aClipId === clipId` and the field is omitted.
- `diffs[]` may now include the string `"clipBoundaries"`.
- `newInB[]` and `removedFromB[]` shapes are unchanged (still only song + metadata, no boundary info needed since these are unpaired clips).

### Edge cases worth being explicit about

- **A clip in A, two clips of the same song in B:** the A row pairs with the first B row. The second B row remains and goes to `newInB`.
- **Two clips in A, one clip in B (same song):** the first A row pairs with B's row; the second A row goes to `removedFromB`.
- **Identical playlists:** both passes terminate empty. Output is unchanged.
- **Same song with same `start`/`length` but different `clip.id`** (e.g. two users independently created the same clip): the second pass pairs them; `diffs` may be empty if metadata also matches → the entry is NOT added to `modifiedInB` (skipped, same as the `clipId` path). This avoids noise.

### Migration / compatibility

This is a behavior change of an existing route's response payload (adds fields, may add an extra diffs entry). No clients other than our own frontend consume this route, so we update both ends in lockstep.

### File changes summary (Part 2)

- Modify: `backend/src/routes/playlists.js` — rewrite `buildDiff` to do two-pass matching.
- Modify: `frontend/src/components/tools/DiffReport.js` — handle the `clipBoundaries` field in the per-row diffs list.

---

## Out of scope

- Renaming `/tools/diff` to anything else; URL stays.
- Tile icons or images for the hub.
- "Recently used tools" sort order.
- A search box on the hub.
- Optimal clip-pair matching when both sides have multiple clips of the same song (Option B from the "Why in order?" section).
- Bi-directional diff or 3-way diff.
- Pitch comparison.

## Manual test plan

### Hub
1. Visit `/tools` → see one "Diff" tile with title and description. Clicking it goes to `/tools/diff`.
2. Navbar shows "Tools" between "Playlists" and "Guide" on desktop.
3. Navbar on phone: no "Tools" entry in the mobile dropdown.
4. Playlist overflow menu (desktop and phone): no "Diff" entry.

### Diff matching
5. Diff a playlist against an exact copy of itself with no edits → all three sections empty.
6. Copy A → B, change one clip's `start` in B → entry shows in "Modified" with the `clip:` diff line. No "Removed" or "New" entries for that song.
7. Copy A → B, add a brand-new song that wasn't in A → entry shows in "New". No false "Modified".
8. Copy A → B, delete a song entirely → entry shows in "Removed". No false "Modified".
9. Same-song pairing: A has one clip of song X at start=30; B has two clips of song X (start=30 and start=60). Expected: the start=30 pair matches by clipId (no entry); the second B clip lands in "New".
10. Mixed: diff the two real playlists from the bug report (A=`65d04155…`, B=`5b2687e9…`). Expected: the 4 entries that were previously in "Removed" (心痛, 梦, 邂逅, 十大金曲串烧) now appear in "Modified" with a `clip:` field showing the start change. The "Removed" list is empty (these were the only 4 entries). The "New" list shrinks by 4 entries (no longer counting these as new).
