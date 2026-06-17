# Next / Previous Unliked Clip Navigation — Design

**Date:** 2026-06-17
**Status:** Approved (design), pending implementation plan

## Summary

Add manual **Next-unliked** and **Previous-unliked** playback controls to the
playlist detail page. "Next/previous" means the next/previous clip in the
playlist that the current user has **not** liked — liked clips are skipped.
Pressing a button jumps to that clip and starts it from the beginning.

This surfaces, as manual buttons, the same "skip liked clips" behavior that the
app already performs automatically when a clip finishes (auto-advance), and adds
the previously-missing backward direction.

## Background / Current State

- The playlist page renders a **vertical list of player cards**, one
  `PlayerBox` per clip. There is no single global player bar.
- Each card has its own play / replay / like controls.
- `PlayerBox.handleClipEnded` already auto-advances to the **next unliked clip**
  when a clip ends and `autoPlayEnabled` is on (it searches forward from the
  current index and skips clips whose key is in `likedClips`).
- There are **no manual next/prev controls** today, and **no backward** search.
- `usePlayerStore`:
  - `likedClips` — a `Set` of `"playlistId:clipId"` keys, scoped to the current
    user.
  - `triggerPlayFromStart(clipId)` — programmatically starts a clip from its
    beginning; the target card's effect plays and scrolls it into view.

## Decisions (confirmed)

| Decision | Choice |
| --- | --- |
| Button placement | On the **currently-playing card only**, next to play/replay |
| Reference clip | The playing clip's index (`clipIndex`) |
| At the ends (no unliked clip in that direction) | **Disable** the button (no wrap-around) |
| On press | **Play immediately** from the start of the target clip |
| "Liked" basis | **Current user's** likes (`likedClips`) |
| Availability | **Always available** to anyone viewing the playlist (NOT gated by `autoPlayEnabled`) |
| Approach | **A** — shared pure helper, reused by both auto-advance and the new buttons |

## Architecture

### 1. Shared pure helper

New module: `frontend/src/lib/clipNav.js`

```js
/**
 * Find the nearest clip in `direction` (+1 forward, -1 backward) starting from
 * `fromIndex`, whose like-key is NOT in `likedClips`.
 * Returns the matching index, or -1 if none exists (no wrap-around).
 */
export function findAdjacentUnliked(allClips, fromIndex, direction, likedClips, playlistId)
```

Behavior:
- Starts at `fromIndex + direction`, walks toward the end (forward) or start
  (backward).
- Skips null/holes (`if (!clip) continue`).
- Skips clips where `${playlistId}:${clip.clipId}` is in `likedClips`.
- Returns the first match's index, or `-1`.
- No wrap-around.

The reference clip itself is never returned (search starts at
`fromIndex + direction`).

### 2. Refactor existing auto-advance

`PlayerBox.handleClipEnded` is changed to call `findAdjacentUnliked(...,
direction = +1, ...)` instead of its inline forward loop. Behavior-preserving;
removes duplicated logic so manual Next and auto-advance can never diverge.

### 3. UI buttons

Rendered **only when `isPlaying === true`**, in the controls row, in both:
- the **desktop** view (controls row alongside play/replay), and
- the **phone expanded** view's control grid.

Not rendered in the phone **collapsed** view (no controls there; a playing clip
is expanded anyway).

- **Prev-unliked** — skip-back icon; on click computes
  `findAdjacentUnliked(allClips, clipIndex, -1, likedClips, playlistId)`; if
  `>= 0`, calls `triggerPlayFromStart(allClips[idx].clipId)`.
- **Next-unliked** — skip-forward icon; same with `direction = +1`.
- **Disabled** (greyed, `disabled` attr) when the helper returns `-1` for that
  direction.
- Inline-SVG icons matching the existing play/replay style.
- `aria-label` via `t("prevUnliked")` / `t("nextUnliked")`; add keys to both
  `frontend/src/i18n/zh.js` and `frontend/src/i18n/en.js`.

The playing card subscribes to `likedClips`
(`usePlayerStore((s) => s.likedClips)`) so disabled state updates live as the
user likes/unlikes clips. The card already receives `allClips`, `clipIndex`,
and `playlistId`.

## Data Flow (on press)

1. User clicks Next/Prev on the playing card.
2. Handler reads latest `likedClips` and calls `findAdjacentUnliked(...)`.
3. If index `>= 0` → `triggerPlayFromStart(allClips[index].clipId)` → target
   card's existing effect plays from start and scrolls into view; that card
   becomes the new playing card and shows the buttons (natural chaining).
4. If index `< 0` → button was disabled; no-op.

## Edge Cases

- No unliked clip ahead/behind → button disabled.
- All clips liked → both disabled.
- Holes/nulls in `allClips` → skipped.
- Current clip liked → irrelevant; search excludes the reference clip.
- Single-clip playlist → both disabled.
- Likes change mid-playback → reflected live via the `likedClips` subscription.

## Testing

**Unit tests** for `findAdjacentUnliked` (pure function):
- Forward finds the next unliked clip (skipping liked ones in between).
- Backward finds the previous unliked clip.
- Returns `-1` at the forward edge / backward edge.
- Returns `-1` when all other clips are liked.
- Skips null/hole entries.
- Single-clip playlist → `-1` both directions.

**Manual / browser check:**
- Buttons appear only on the playing card.
- Pressing plays the target clip from start and scrolls it into view.
- Disabled states correct at the ends.
- Liking the only remaining neighbor disables the button live.

## Out of Scope (YAGNI)

- Keyboard shortcuts.
- Wrap-around at the ends.
- "Any user" like basis (only current-user likes).
- A global/sticky player bar.
- Gating the buttons behind `autoPlayEnabled`.
