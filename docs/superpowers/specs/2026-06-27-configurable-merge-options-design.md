# Configurable Merge Field-Source Options — Design

**Date:** 2026-06-27
**Status:** Approved (design), pending implementation plan
**Area:** `/tools/merge` — playlist merge

## Problem

The merge tool (`/tools/merge`) creates a new playlist `更新版 {A}` by updating
baseline playlist A with source playlist B. Today the per-field resolution rules
are **hardcoded** in `buildMergeRows` (e.g. matched clips always take B's speed,
A's pitch, union of color tags, B's section label; same-song/different-clip
always keeps A's clip and flags it; ordering always follows B). Users cannot
control these choices.

Goal: make the resolution choices **configurable per merge** (global, not
per-clip), so the merge is more robust, while keeping today's behavior as the
default so existing usage is unaffected.

## Scope

- **Global options**, applied to the whole merge (not a per-clip interactive review).
- **7 configurable fields** via a `MergeOptions` object.
- Defaults reproduce current behavior exactly.

## MergeOptions shape & defaults

```js
mergeOptions = {
  speed:        "A" | "B",                 // default "B"
  pitch:        "A" | "B",                 // default "A"
  comment:      "A" | "B" | "combine",     // default "A"
  colorTag:     "A" | "B" | "combine",     // default "combine"  (today's union)
  sectionLabel: "A" | "B",                 // default "B"
  clipCut:      "A" | "B",                 // default "A"  (which audio clip on same-song/diff-clip)
  order:        "A" | "B",                 // default "B"  (clip sequence in result)
}
```

- **speed / pitch / sectionLabel** — pick-a-side.
- **comment** — A-only, B-only, or `combine` (A then B, newline-joined, empties skipped, duplicates not doubled).
- **colorTag** — A-only, B-only, or `combine` (existing `unionColorTags`).
- **clipCut** — Rule 2 only (same song, different `clip.id`):
  - `"A"` → keep A's clip, append `[B 中的片段不同]` (today's behavior).
  - `"B"` → use B's clip row instead, **no flag** (user resolved deliberately).
- **order** — emission sequence of the result (see Ordering).

Validated by Zod; each field optional and enum-constrained; missing/unknown → default.

## Backend changes

### `buildMergeRows(aClips, bClips, options)`

Gains a third arg. Separates **row resolution** from **row ordering** so both
order modes share identical resolution logic.

Helpers:
```js
pick(opt, aVal, bVal, combiner?)   // "A"→aVal, "B"→bVal, "combine"→combiner(aVal,bVal)
combineComment(a, b)               // A then B, newline-joined, skip empties/dups
unionColorTags(a, b)               // already exists
```

Rule-by-rule:
- **Rule 1 (Added — song only in B):** unchanged. B's clip copied as-is.
- **Rule 4 (Matched — same clip.id):** every field resolved via options
  (`speed`, `pitch`, `comment`, `colorTag`, `sectionLabel`). clipId identical
  on both sides, so `clipCut` is moot here.
- **Rule 2 (Same song, different clip.id):** branches on `clipCut`:
  - `"A"` → keep A's clip row, append `[B 中的片段不同]`; further B clips of the
    same song append `[B 中存在多个不同片段]` (once). Today's behavior.
  - `"B"` → emit a row using **B's clipId**, with speed/pitch/comment/colorTag/
    sectionLabel resolved via options against the matched A clip; **no flag**.
    The matched A clip is marked consumed so Rule 5 won't re-emit it.
- **Rule 5 (Deleted — A clip never matched):** unchanged. Keeps A's fields,
  appends `[此歌已删]`.

### Ordering (`order`)

- **`"B"` (default — today's behavior):** matched + clip-cut-from-B + added clips
  in B's order; Rule-2-kept-A rows at B's position; Rule 5 (A-only) appended at
  bottom in A's order.
- **`"A"`:** walk A's clips in A's order — each A clip emits its resolved row at
  A's position (matched, same-song-diff-clip either side, or A-only flagged
  deleted); then append songs new in B (Rule 1) at the bottom in B's order.

Summary counters (`added / merged / markedDifferent / markedDeleted`) are
identical regardless of `order` — ordering changes only emission sequence.

### `mergePlaylists(callerId, aId, bId, options)`

Threads `options` into `buildMergeRows`. Permissions (A owned by caller; B
viewable), naming (`更新版 {A}`), and new-playlist creation are untouched.

## Frontend changes

- New component `components/tools/MergeOptions.js` — owns the 7 dropdowns, holds
  defaults, emits the options object via `onChange`. Keeps the page focused.
- Merge page renders the panel between the playlist pickers and the Merge button.
  Labels name each side, e.g. "Speed: A (baseline) / B (source)".
- `handleConfirm` passes options to `playlistsAPI.merge(aId, bId, options)`.
- Confirm dialog may list chosen non-default options.
- `playlistsAPI.merge`: `(aId, bId)` → `(aId, bId, options)`, body
  `{ aId, bId, options }`.
- `mergePlaylistSchema` (Zod) gains optional `options` object, each field
  optional + enum-constrained + defaulted → back-compatible with callers that
  omit it.
- New i18n keys (en + zh): panel title, 7 field labels, A/B/Combine option labels.

## Testing

`buildMergeRows` is pure — unit tests in the existing `backend/tests/` style:
- **Defaults reproduce today's output** (no options, and explicit defaults) — regression guard.
- **Each field option flips correctly** on a Rule-4 clip; comment & colorTag across A/B/combine.
- **clipCut on Rule 2:** `"A"` keeps A + flag; `"B"` emits B's clipId, no flag, A consumed (not re-emitted by Rule 5).
- **order A vs B:** same fixture, different emission sequence, identical summary counters.
- **combineComment:** empties skipped, dups not doubled, A-then-B order.

## Error handling

- Zod validates `options`; unknown enum → 400 with clear message. Missing options/fields → defaults.
- No new failure modes in permissions, not-found, or naming.

## Out of scope

- Per-clip interactive merge review (preview → commit).
- Changing the `更新版` naming or the diff tool.
- Persisting option presets.
