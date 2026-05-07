# Admin Auto-Play Mode — Design

## Summary

Add an admin-only toggle on the playlist page that, when enabled, automatically plays the next clip in playlist order after the current clip ends naturally. Liked clips are skipped (matching their visual de-emphasis). Auto-advance fires only on natural end-of-clip — pausing or switching to another clip does not break the chain, it just doesn't trigger an advance at that moment. The chain picks back up the next time any clip ends naturally. Toggle state persists in localStorage. Per-clip speed and pitch settings continue to apply.

## Behavior

When auto-play is OFF, every action below behaves exactly as it does today (no advance ever fires). When auto-play is ON:

| User action on the currently-playing clip | What happens |
|---|---|
| Clip plays through to its natural end | Advance to next eligible clip (skipping liked clips); if none, stop |
| User pauses the clip | No advance — clip stays paused |
| User pauses, then resumes, then lets it end naturally | Advance fires at the natural end |
| User pauses, then clicks play on a different clip | The new clip plays; when *it* ends naturally, advance from its position |
| User clicks play on a different clip mid-playback (no pause) | Same as above — the new clip plays; advance fires at *its* natural end |
| User seeks within the clip | No effect on chain |
| End of playlist reached (last eligible clip ends) | Stop. No wraparound |

The rule reduces to: **only natural end-of-clip triggers advance**. Pause and switch never trigger advance, but they don't disable the chain either — whichever clip is playing next will advance when *it* ends naturally.

Filter (`gridSearch` / `phoneSearch`) does not affect auto-play targeting; the chain walks the full `playlist.clips` in position order.

## Architecture

Approach: reuse the existing `playFromStartClipId` signal pattern that the sidebar already uses to remotely trigger playback in another `PlayerBox`. The end-of-clip handler in the currently playing `PlayerBox` decides the next clip and writes it to the store; the matching target `PlayerBox` consumes the signal via its existing `useEffect` and calls `playFromStart`.

## Components & data flow

### `playerStore` (frontend/src/store/playerStore.js)

Add:

- `autoPlayEnabled: boolean` — initialized from `localStorage.getItem("music_app_autoplay") === "true"` (default `false`).
- `setAutoPlayEnabled(v)` — sets state and writes `"true"`/`"false"` to `localStorage` under key `music_app_autoplay`.

The flag is global, not per-playlist. No role gating in the store; gating is at the UI layer.

### `PlaylistHeader` (frontend/src/components/playlist/PlaylistHeader.js)

Add a toggle button rendered only when the current user is ADMIN. The header reads the role via `useAuth()` directly (avoids prop-drilling).

- Visible regardless of `editMode` and `playlist.isOwner`.
- Two visual states using existing button styling conventions in this file:
  - ON: filled style (`bg-primary text-white shadow-sm`), label `t("autoPlayOn")`.
  - OFF: bordered style (`border border-border bg-surface hover:bg-surface-hover`), label `t("autoPlayOff")`.
- Reads `autoPlayEnabled` and calls `setAutoPlayEnabled` from `playerStore`.

New i18n keys `autoPlayOn` and `autoPlayOff` are added to the existing language file(s) used by `useLanguage()`.

### `useAudioPlayer` (frontend/src/hooks/useAudioPlayer.js)

Add an optional `onClipEnded` callback prop. It fires on natural end only:

- The `PitchShifter` `onEnd` callback at lines ~184–191: after `stopShifter()`, `setCurrentTime(0)`, `offsetRef.current = 0`, `setIsPlaying(false)`, invoke `onClipEnded?.()`.
- The time-tracking loop at lines ~93–99 when `time >= clipLength`: same.

It must NOT fire from `pause()`, from the unmount cleanup, from `seek()` restarts, from `stopShifter()` triggered by `activePlayerId` change (clip switching), or from `playEpoch` invalidation paths. Only the two natural-end paths invoke it.

### `PlayerBox` (frontend/src/components/player/PlayerBox.js)

- Reads `autoPlayEnabled` from the store via `usePlayerStore((s) => s.autoPlayEnabled)`.
- Defines a stable `handleClipEnded` callback that:
  1. Returns early if `!autoPlayEnabled`, or `allClips` is missing, or `clipIndex == null`.
  2. Reads `likedClips` once via `usePlayerStore.getState().likedClips`.
  3. Iterates `allClips` from `clipIndex + 1` upward, returning the first clip whose `${playlistId}:${clip.clipId}` key is not in the `likedClips` Set.
  4. If found, calls `triggerPlayFromStart(nextClip.clipId)`.
- Passes `handleClipEnded` to `useAudioPlayer` as `onClipEnded`.

The next-clip lookup is contained entirely in `PlayerBox`. No prop changes to `PlaylistGrid` or `page.js`.

### `PlaylistGrid` / `page.js`

No changes required. `allClips`, `clipIndex`, and `playlistId` are already passed to `PlayerBox`.

## Edge cases

- **Currently-playing clip is itself liked.** The next-clip search starts at `clipIndex + 1`, so the playing clip is skipped naturally and the chain still advances.
- **User likes the next clip during current playback.** The `getState()` read at end-of-clip sees the latest `likedClips`, so the freshly-liked clip is skipped.
- **All remaining clips are liked.** Loop returns nothing → no `triggerPlayFromStart` call → playback ends silently.
- **End of playlist.** Same as above; no wraparound.
- **User manually pauses.** `pause()` does not invoke `onClipEnded`; no advance at the pause moment. Resuming and letting the same clip end naturally fires `onClipEnded` and advances. The chain is not permanently broken by a pause.
- **User switches to another clip mid-playback (with or without pausing first).** The first clip's playback ends via `stopShifter()` from the `activePlayerId` effect — not a natural end — so `onClipEnded` does not fire from the first clip. The new clip plays and, on its own natural end, advances normally from *its* position.
- **Search filter active.** Targeting walks the full `playlist.clips`, ignoring the filter. Acceptable per requirements ("Next in playlist order").
- **Non-admin user with `autoPlayEnabled` somehow true.** No UI to toggle it, but the chaining logic would still run. Considered harmless; no role check needed in the chain logic.

## Verification

No automated test infrastructure exists in `frontend/`; verification is manual in the browser. Run `cd backend && npm run dev` and `cd frontend && npm run dev`, then:

1. Toggle visibility — visible to ADMIN, hidden to MEMBER.
2. Persistence — turn ON, reload, still ON; turn OFF, reload, still OFF; open a different playlist, state preserved.
3. Basic chain — clip #1 → #2 → #3 at natural ends; each clip uses its own saved speed/pitch.
4. Skip liked — like #2, play #1, expect #3 next; like all remaining, expect stop.
5. Pause behavior — pause mid-clip, no advance; resume and let it finish, advance fires (chain not broken by the pause).
6. Manual clip switch — while #1 plays, click play on #5; #1 stops without advancing; #5 ends and advances to #6. Same outcome whether or not user paused #1 first.
7. End of playlist — second-to-last advances to last; last stops cleanly with no wraparound.
8. OFF — toggle off, playback ends, no advance (regression check).
9. Edit mode coexistence — enable edit + auto-play, chain still works.

## Out of scope

- Wraparound at end of playlist.
- Following the search filter for auto-play targeting.
- Shuffle / queue / repeat-one.
- Per-playlist auto-play preference.
- Backend persistence of preference (localStorage only).
- Automated tests (none exist in this codebase yet).
