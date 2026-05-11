# Playlist Merge Tool — design

Adds a Merge tool under `/tools` alongside the existing Diff tool. Given a baseline playlist A (owned by the caller) and a source playlist B (owned, public, or copy-allowed for the caller), the tool produces a new playlist owned by the caller that combines them according to specific rules. A and B are untouched.

Also adds a small enhancement to both Diff and Merge: playlist pickers display the owner username alongside the playlist name.

## Goal

Allow a user to fold updates from another playlist (B) into their own playlist (A) — picking up new clips, syncing speeds, combining color tags, while preserving A's existing comments and tracking what changed.

## Entry point

- New tile on `/tools` titled "Merge" with description (Chinese: "把另一个列表的更新合并到我的列表，生成新列表。" / English: "Merge updates from another playlist into yours, creating a new playlist.").
- New page `/tools/merge`. Phone-hidden via the same `window.matchMedia('(min-width: 768px)')` pattern used by the Diff page.
- No entry from the playlist detail page.

## Permissions

- **A (first picker)**: caller must be the owner. Server enforces 403 if not.
- **B (second picker)**: caller must have at least one of: owner, `playlist.isPublic`, or a row in `playlist.copyPermissions` for the caller. Server enforces 404 if not viewable, 403 if viewable but not copy-eligible.
  - Note: shares alone do not grant merge access. This matches the user's stated requirement ("owned or public or copiable") and matches the existing `canCopy` semantics from `playlistAccess` middleware.

## Output playlist

A new `Playlist` row owned by the caller:
- `name`: `更新版 <A.name>` (Chinese-only, since the annotation strings are also Chinese-only — keeps the merge output internally consistent in language).
- `description`: A's description (carried over).
- `isPublic`: `false`.
- No shares, no copyPermissions.
- All playlistClips created in a single transaction.

The new playlist is returned to the client, which navigates to `/playlists/<new.id>` after merge.

## Merge rules (per clip in the result)

The result's clip order is:
1. For each clip in **B's** position-asc order: produce one result clip (Rule 1, 2, or 4 below).
2. Then append: each clip in A whose `song.id` is NOT in B's `song.id` set, in A's position-asc order (Rule 5).

### Rule 1 — Song in B, not in A
- Take B's clip as-is.
- Result row: `{ clipId: B's, speed: B's, colorTag: B's, comment: B's, sectionLabel: B's }`.

### Rule 4 — Song in both, same `clip.id`
- Result row:
  - `clipId`: A's (which equals B's by definition).
  - `speed`: **B's**.
  - `colorTag`: **union of A's and B's color sets**. See "Color tag union" below.
  - `comment`: **A's, unchanged**. No merged-comment line.
  - `sectionLabel`: **B's**.
- Position: B's order.

### Rule 2 — Song in both, different `clip.id`(s)
Triggered when at least one clip in B has the same `songId` as a clip in A but a different `clip.id`.

Resolution within the result:
- The result includes **A's clip** for that song (we keep A's clipId, speed, colorTag, comment, sectionLabel).
- A's comment gains an appended annotation line `[B 中的片段不同]`.
- If B has more than one clip with the same `songId` but different `clip.id`s, an additional annotation line `[B 中存在多个不同片段]` is appended (no count number — fixed string regardless of how many).
- B's diff-`clip.id` rows do **not** produce separate result entries.

Order placement: A's clip is placed at the position of B's **first** diff-`clip.id` clip for that song (so the resulting playlist tracks B's overall order). Subsequent B clips of the same song are skipped for ordering purposes.

If multiple A clips share the same `songId` (rare but possible): only the **first A clip** for that song receives the annotation and the order placement. Subsequent A clips of the same song are treated as if they had no B match — they fall through to Rule 5 (song-in-A-not-in-B from their perspective: their `clip.id` isn't in B and another A clip has already claimed the song's "B order slot").

### Rule 5 — Song in A, not in B
- Append at the bottom of the result, in A's position-asc order.
- A's comment gains an appended annotation line `[此歌已删]`.

### Annotation appending
For Rules 2 and 5, if A's existing comment is empty/null, the annotation becomes the comment on its own (no leading newline). If A's comment is non-empty, the annotation is appended on a new line (`\n`) after the existing comment.

For Rule 2 the order is: existing comment, then `[B 中的片段不同]`, then (only if applicable) `[B 中存在多个不同片段]`.

### Color tag union
Color tags are stored as pipe-separated strings (e.g. `"red|blue"` — verified in `frontend/src/components/player/ColorTag.js`).

Union procedure:
1. Parse A's colorTag and B's colorTag with `split('|').filter(Boolean)` → two arrays.
2. Concatenate, then dedupe preserving order (A's colors first, then B's colors that aren't already in A's).
3. If the result is empty, store `null`. Otherwise join with `|`.

This matches the existing client-side encoding so the result renders identically in the player UI.

### Pitch
Not touched. The result row's `pitch` is A's pitch for Rules 2, 4, 5; B's pitch for Rule 1.

## Backend

### Route

```
POST /api/playlists/merge
Body: { aId: <uuid>, bId: <uuid> }
```

`POST` because it mutates state (creates a new playlist). Returns `201` with the created playlist's id and name on success.

### Validation
- Body validated by a new Zod schema (`mergePlaylistSchema` in `validators/playlists.js`): both `aId` and `bId` required, both must be valid UUIDs, `aId !== bId`.
- 400 if missing or malformed; same shape as the diff route's errors.

### Access checks
- A: `findUnique`, check `aPl.userId === req.user.id`. If not, return 403 with `{ error: { message: 'You must own the baseline playlist' } }`.
- B: `findUnique` with `copyPermissions: { where: { userId: req.user.id }, take: 1 }`. View access is `userId === caller || isPublic || copyPermissions.length > 0`. (Shares are intentionally excluded.) If not viewable: 404 with `{ error: { message: 'Playlist not found' } }`. (No 403 distinct from 404 here — matches how the diff route conceals access for unauthorized peeking.)

### Algorithm
```
1. Load A's playlistClips with clip.{id, songId} and song.{title, artist}.
2. Load B's playlistClips with the same fields, plus B's pitch (not needed for merge but cheap).
3. Build a Map of A's clips by `clip.songId` → array of A playlistClips (ordered by position).
4. Build a Set of B's `song.id`s (for Rule 5 detection).
5. Iterate B's clips in position-asc order. For each B clip:
   a. Let aMatches = A's clips with the same songId.
   b. If aMatches is empty: Rule 1. Emit a result row from B as-is.
   c. Else: scan aMatches for one whose clip.id === B's clip.id.
      - If found: Rule 4. Emit using that A clip's clipId, B's speed, union(A.colorTag, B.colorTag), A's comment (unchanged), B's sectionLabel.
      - If not found: Rule 2. Need to track first-encounter:
          - On first B clip for this songId: emit A's first unused clip for that songId, with A's data, and append `[B 中的片段不同]` to its comment.
          - On second or later B clip for same songId (still no clip.id match): append `[B 中存在多个不同片段]` to the comment of the result row already emitted for this song's first encounter — but only once. Don't emit a new result row.
      - In both Rule 2 sub-cases, mark this A clip as "consumed" so it isn't reused.
6. After B loop: for each A clip not consumed by the loop above, AND whose songId is not in B's songId set, emit at the bottom with `[此歌已删]` appended to comment.
   - For A clips whose songId IS in B's set but weren't claimed by Rule 4 / Rule 2's first-encounter (e.g. multiple A clips of the same song where only one was needed) — same treatment as not-in-B: append `[此歌已删]` and place at bottom. (Rationale: from the user's perspective, B's view of that song is captured by one entry; A's extras are "deleted in B".)
7. Insert all rows into a new playlist in a single transaction.
```

Edge case: if A has zero clips, result is just a copy of B (every B clip is Rule 1). If B has zero clips, result is A with every clip marked `[此歌已删]`. Both are degenerate but valid.

### Response

```json
{
  "id": "<new playlist uuid>",
  "name": "更新版 ...",
  "summary": {
    "added": 12,        // Rule 1 count
    "merged": 5,        // Rule 4 count
    "markedDifferent": 3, // Rule 2 count (number of A clips that got the annotation)
    "markedDeleted": 2  // Rule 5 count
  }
}
```

The summary is used by the client for a post-merge toast or modal; it doesn't affect playback. (Optional — could be omitted and recomputed client-side, but server is cheaper since it has the data already.)

## Frontend

### Page: `frontend/src/app/tools/merge/page.js`

Structure:
- Phone-detect via `window.matchMedia('(min-width: 768px)')`. If `!isDesktop`, render `t("toolsDesktopOnly")` (rename existing `diffDesktopOnly` → `toolsDesktopOnly` since the string is now shared, or add a new equivalent key — see "i18n changes" below).
- Heading: `t("merge")`.
- Two pickers (use the existing `PlaylistPicker` with the new owner-display enhancement):
  - A picker: label `t("mergeBaseline")` ("我的列表 (A)" / "Baseline (A)"). Filter: only playlists owned by the caller (see "Picker owner-filter" below).
  - B picker: label `t("mergeSource")` ("合并来源 (B)" / "Source (B)"). Filter: none (default — return any viewable playlist).
- Confirmation: a "Merge" button (disabled until both A and B are selected). Clicking it opens a confirmation modal showing the summary line if we precompute it (see below), then on user confirm, calls the API.
- Summary precompute: optional. Simplest: don't precompute. The confirmation modal just says `将创建新列表「更新版 X」，确认合并？`. The summary appears as a toast after the merge succeeds. This keeps the page round-trip-light.
- On success: `router.push('/playlists/<new.id>')`.

### Component: PlaylistPicker enhancement

Today PlaylistPicker shows just `{p.name}` in the dropdown. Enhance to show `{p.name} — {p.user.username}` (em-dash separator, matches existing "title — artist" pattern elsewhere).

Two new props on `PlaylistPicker`:
- `ownerOnly?: boolean` — if true, filter results to playlists where `p.isOwner === true`. The existing `playlistsAPI.list` response includes `isOwner` per playlist (in `playlistService.getUserPlaylists`).
- The owner field is already in the API response under `p.ownerName` (when not owner) — but for owned playlists it's not present today since `ownerName` is intentionally hidden. We need to surface the owner's username consistently. **Simplest fix**: in `getUserPlaylists`, always include the username (call it `ownerName` for non-owners, and for owners the picker can fall back to `t("you")` / "我" if `isOwner === true` and `ownerName` is absent).
  - Alternative: change `getUserPlaylists` to always return `ownerName`. Less code in the frontend; one tiny backwards-compat shift in the API response.

Decision: **always return `ownerName`** in `getUserPlaylists` (both for owners and non-owners). Existing consumers that conditionally show `ownerName` only when `!isOwner` continue working because they branch on `isOwner` first.

Picker rendering: if `p.isOwner` → show `{p.name} — {t("you")}`. Else → `{p.name} — {p.ownerName}`.

### API client

Add to `playlistsAPI`:
```js
merge: (aId, bId) => api.post('/playlists/merge', { aId, bId }),
```

### Tools hub

Append a second tile after Diff:
```js
{
  id: "merge",
  href: "/tools/merge",
  title: t("merge"),
  description: t("toolsMergeDescription"),
},
```

### i18n additions

| Key | English | Chinese |
|---|---|---|
| `merge` | Merge | 合并 |
| `toolsMergeDescription` | Merge updates from another playlist into yours, creating a new playlist. | 把另一个列表的更新合并到我的列表，生成新列表。 |
| `mergeBaseline` | Baseline (A) — must be yours | 我的列表 (A) |
| `mergeSource` | Source (B) | 合并来源 (B) |
| `mergeButton` | Merge | 合并 |
| `mergeConfirmTitle` | Confirm merge | 确认合并 |
| `mergeConfirmBody` | Will create a new playlist named "{name}". Continue? | 将创建新列表「{name}」，确认合并？ |
| `mergeSuccessSummary` | Created "{name}": {added} added · {merged} merged · {markedDifferent} marked different · {markedDeleted} marked deleted | 已创建「{name}」：{added} 新增 · {merged} 合并 · {markedDifferent} 标记不同 · {markedDeleted} 标记删除 |
| `mergeOnlyOwnedA` | You must own the baseline playlist | 必须是 A 列表的拥有者 |
| `you` | you | 我 |

Reuse existing `diffSwap`, `diffChange`, `diffSelectPlaylist`, `diffDesktopOnly` (rename the latter for shared use): suggest **renaming** `diffDesktopOnly` → `toolsDesktopOnly` and updating both Diff and Merge pages to use it. The string contents are unchanged.

Annotation strings used by the **backend** (server-rendered into comments):
- `[B 中的片段不同]`
- `[B 中存在多个不同片段]`
- `[此歌已删]`

These are hard-coded in the backend's merge service (not in i18n) because comments are persisted strings. If you ever switch UI languages, persisted comments don't retranslate. This is consistent with the user's choice to make the annotations Chinese-only.

### Confirmation modal

Inline in `page.js`, kept simple:
```jsx
{showConfirm && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div className="mx-4 w-full max-w-md rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-2 text-lg font-semibold">{t("mergeConfirmTitle")}</h2>
      <p className="mb-4 text-sm text-muted">{t("mergeConfirmBody").replace("{name}", `更新版 ${aPlaylist.name}`)}</p>
      <div className="flex justify-end gap-2">
        <button onClick={() => setShowConfirm(false)} ...>{t("cancel")}</button>
        <button onClick={handleConfirm} ...>{t("mergeButton")}</button>
      </div>
    </div>
  </div>
)}
```

Reuses existing `cancel` key.

## Out of scope

- Auto-creating a backup of A before merge (the merge IS a new playlist; A is never mutated).
- Three-way merge or merging multiple sources at once.
- Preview of what will change before merging (`Diff` already serves this purpose; user can run Diff first if curious).
- Pitch comparison or merge.
- Editing the result name/visibility from the merge confirmation modal (user can rename afterwards via the playlist edit UI).
- Phone UI for the merge page (desktop-only, matching Diff).
- Including share-only playlists in the B picker.
- Removing or modifying the existing `diffDesktopOnly` semantics; the rename to `toolsDesktopOnly` is the only change to the existing i18n.

## Manual test plan

1. **Permission gate — A not owned.** Set A to a playlist not owned by the caller. Server returns 403 with the proper message. The picker shouldn't allow selecting a non-owned playlist for A; this also catches users who type the id manually. Verify both.
2. **Permission gate — B not viewable.** B is a private playlist not owned/shared/copyable. Server returns 404.
3. **Permission gate — B shared but not copyable.** B is shared with the caller but `canCopy` is false. Server returns 404 (intentional — share alone does not grant merge).
4. **Rule 1 — pure addition.** A has no clips; B has 3. Result is a 3-clip playlist named `更新版 <A.name>` matching B exactly (same clipIds, same metadata).
5. **Rule 4 — same clipId.** A and B both contain clip X. A's clip has speed=1.0, colorTag=`red`, comment="A note", sectionLabel="verse". B's has speed=1.5, colorTag=`blue`, comment="B note", sectionLabel="chorus". Result row: speed=1.5, colorTag=`red|blue`, comment="A note" (unchanged — Rule 4 does NOT merge comments), sectionLabel="chorus".
6. **Rule 4 — color tag union dedupe.** A's clip has colorTag=`red|blue`; B's has `blue|green`. Result colorTag=`red|blue|green`.
7. **Rule 2 — different clipId same song, B has one such clip.** A has clip Xa for song S; B has clip Xb for song S (different clip.id). Result includes A's clip Xa with comment ending in `[B 中的片段不同]`. B's clip Xb is NOT separately added.
8. **Rule 2 — multiple B clips of same song with different clipIds.** A has clip Xa for song S; B has clips Xb1, Xb2 (different clipIds) for song S. Result has one entry: A's clip Xa with `[B 中的片段不同]` AND `[B 中存在多个不同片段]` appended on separate lines.
9. **Rule 5 — song not in B.** A has clip Xa for song T; B has no clip of song T. Result row: A's clip Xa at the bottom, with `[此歌已删]` appended to its comment.
10. **Ordering.** Mix of all four rules — verify result order is B-order for the first three rule categories, then A-order tail for Rule 5.
11. **Empty A comment + annotation.** A's clip has no comment; Rule 2 fires. Result comment is exactly `[B 中的片段不同]` (no leading newline).
12. **Non-empty A comment + annotation.** A's clip has comment "hi"; Rule 5 fires. Result comment is `hi\n[此歌已删]` (two lines).
13. **A has multiple clips of the same song.** A has two clips of song U (different clipIds); B has one matching clip (Rule 4 with A's first). The second A clip of U falls to bottom with `[此歌已删]`.
14. **Picker owner display.** Open the Merge page. Search in the A picker — results show `{name} — 我`. Search in the B picker — results show `{name} — {ownerName}` (or `{name} — 我` when the result is also owned by the caller).
15. **Picker owner filter on A.** Search in the A picker for a playlist you don't own — it should not appear.
16. **Confirmation modal.** Pick A and B, click Merge → confirmation modal appears. Cancel → nothing happens. Confirm → API call fires, navigates to new playlist.
17. **Post-merge toast.** After navigation, a toast or inline summary shows counts.
18. **Phone gating.** Resize <md width. The Merge tile is still visible on `/tools` (the hub is not phone-gated, same as today). Visiting `/tools/merge` directly shows the desktop-only notice. The page itself does not appear.
19. **Self-merge blocked.** Try to set A and B to the same playlist. Backend returns 400 (same as Diff's self-diff rule).
20. **Same-named playlists, different owners.** Two playlists named `summer mix` owned by different users — the picker shows them distinctly via the `— owner` suffix.
