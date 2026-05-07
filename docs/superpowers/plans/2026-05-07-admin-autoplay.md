# Admin Auto-Play Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only toggle on the playlist page that auto-advances to the next eligible (non-liked) clip when the current clip ends naturally.

**Architecture:** A new `autoPlayEnabled` flag in the existing `playerStore` Zustand store, persisted to localStorage. `useAudioPlayer` exposes a new `onClipEnded` callback that fires only on natural end of clip. `PlayerBox` consumes the callback, looks up the next non-liked clip in `allClips`, and triggers playback by reusing the existing `triggerPlayFromStart` signal that the sidebar already uses. A new admin-gated toggle button is added to `PlaylistHeader`.

**Tech Stack:** Next.js 14 (App Router), React 18, Zustand 4.5, Tailwind. No backend changes. No new dependencies.

**Spec reference:** [docs/superpowers/specs/2026-05-07-admin-autoplay-design.md](../specs/2026-05-07-admin-autoplay-design.md)

**Note on testing:** This codebase has no frontend test framework configured. Each task ends with manual browser verification steps the engineer must perform. The dev servers are started with `cd backend && npm run dev` and `cd frontend && npm run dev`; log in as an admin user (seed via `cd backend && node scripts/seed-admins.js` if needed).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `frontend/src/store/playerStore.js` | Modify | Add `autoPlayEnabled` state + `setAutoPlayEnabled` setter with localStorage persistence |
| `frontend/src/i18n/zh.js` | Modify | Add `autoPlayOn`, `autoPlayOff` Chinese strings |
| `frontend/src/i18n/en.js` | Modify | Add `autoPlayOn`, `autoPlayOff` English strings |
| `frontend/src/components/playlist/PlaylistHeader.js` | Modify | Render admin-only toggle button bound to the store |
| `frontend/src/hooks/useAudioPlayer.js` | Modify | Accept `onClipEnded` prop; invoke it on natural-end paths only |
| `frontend/src/components/player/PlayerBox.js` | Modify | Implement next-clip lookup + dispatch on clip end |

No files are created. All changes are local to the frontend.

---

## Task 1: Add `autoPlayEnabled` to playerStore with localStorage persistence

**Files:**
- Modify: `frontend/src/store/playerStore.js`

- [ ] **Step 1: Read the file to confirm current structure**

Run: open `frontend/src/store/playerStore.js`. Confirm it exports a Zustand store with `activePlayerId`, `playFromStartClipId`, and `likedClips`.

- [ ] **Step 2: Add `autoPlayEnabled` and setter**

Replace the entire file contents with:

```js
import { create } from "zustand";

const AUTOPLAY_KEY = "music_app_autoplay";

const readAutoPlay = () => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AUTOPLAY_KEY) === "true";
  } catch {
    return false;
  }
};

const writeAutoPlay = (v) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTOPLAY_KEY, v ? "true" : "false");
  } catch {
    // ignore quota / private-mode errors
  }
};

const usePlayerStore = create((set, get) => ({
  // Global playback — only one PlayerBox plays at a time
  activePlayerId: null,
  setActivePlayer: (id) => set({ activePlayerId: id }),

  // Sidebar "go to" — clipId to play from start, cleared after consumed
  playFromStartClipId: null,
  triggerPlayFromStart: (clipId) => set({ playFromStartClipId: clipId }),
  clearPlayFromStart: () => set({ playFromStartClipId: null }),

  // Liked clips cache — Set of "playlistId:clipId" keys
  likedClips: new Set(),

  setLikedClips: (clipKeys) => set({ likedClips: new Set(clipKeys) }),

  isClipLiked: (playlistId, clipId) =>
    get().likedClips.has(`${playlistId}:${clipId}`),

  toggleClipLike: (playlistId, clipId) => {
    const key = `${playlistId}:${clipId}`;
    const next = new Set(get().likedClips);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    set({ likedClips: next });
  },

  // Admin auto-play mode — persisted in localStorage
  autoPlayEnabled: readAutoPlay(),
  setAutoPlayEnabled: (v) => {
    writeAutoPlay(v);
    set({ autoPlayEnabled: !!v });
  },
}));

export default usePlayerStore;
```

The `readAutoPlay` call at module load handles SSR safely via the `typeof window` guard. On the client, it reads the persisted value once at module init; the setter writes through on each change.

- [ ] **Step 3: Manually verify in browser console**

Start the frontend (`cd frontend && npm run dev`), open any page in the app, open browser devtools console:

```js
// Read current state
window.__store = (await import("/_next/static/chunks/...store...js")) // skip — easier alternative below
```

Easier: in the React DevTools console after the page loads, type:
```js
localStorage.getItem("music_app_autoplay")
```
Expected: `null` (first load) or `"false"`/`"true"` after later toggling.

Set manually and reload:
```js
localStorage.setItem("music_app_autoplay", "true");
location.reload();
```

After reload, in the same console:
```js
localStorage.getItem("music_app_autoplay")
```
Expected: `"true"`. (Full UI verification comes after Task 3.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/store/playerStore.js
git commit -m "Add autoPlayEnabled flag to playerStore with localStorage persistence"
```

---

## Task 2: Add i18n strings for the toggle label

**Files:**
- Modify: `frontend/src/i18n/zh.js`
- Modify: `frontend/src/i18n/en.js`

- [ ] **Step 1: Add Chinese strings**

Open `frontend/src/i18n/zh.js`. Find the line with `share: "分享",` (around line 138). Immediately after it, on a new line, add:

```js
  autoPlayOn: "自动播放：开",
  autoPlayOff: "自动播放：关",
```

- [ ] **Step 2: Add English strings**

Open `frontend/src/i18n/en.js`. Find the line with `share: "Share",` (around line 138). Immediately after it, on a new line, add:

```js
  autoPlayOn: "Auto-play: ON",
  autoPlayOff: "Auto-play: OFF",
```

- [ ] **Step 3: Sanity-check the files load**

Run: `cd frontend && npm run dev`. Open the app. The page should load without console errors. (Strings aren't used yet, but a syntax error here would break the whole locale module.)

Expected: dev server compiles, page loads, no red errors in browser console.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/i18n/zh.js frontend/src/i18n/en.js
git commit -m "Add i18n strings for auto-play toggle"
```

---

## Task 3: Add admin-only toggle button to PlaylistHeader

**Files:**
- Modify: `frontend/src/components/playlist/PlaylistHeader.js`

- [ ] **Step 1: Add imports**

Open `frontend/src/components/playlist/PlaylistHeader.js`. The current imports are:

```js
"use client";

import { useState } from "react";
import { useLanguage } from "@/components/layout/LanguageProvider";
import RichText from "@/components/ui/RichText";
```

Add two more imports immediately after the `RichText` import:

```js
import useAuth from "@/hooks/useAuth";
import usePlayerStore from "@/store/playerStore";
```

- [ ] **Step 2: Read auth + store inside the component**

Inside `PlaylistHeader`, immediately after the `const { t } = useLanguage();` line, add:

```js
  const { isAdmin } = useAuth();
  const autoPlayEnabled = usePlayerStore((s) => s.autoPlayEnabled);
  const setAutoPlayEnabled = usePlayerStore((s) => s.setAutoPlayEnabled);
```

- [ ] **Step 3: Render the toggle button**

In the always-visible top button row (the `<div className="flex flex-wrap items-center justify-end gap-2">` that contains the Return button — the one ABOVE the `editMode && playlist.isOwner` second row), insert the new button immediately AFTER the Return button and BEFORE the `playlist.isOwner && onUnlikeAll` button.

Find this block:

```jsx
            <button
              onClick={onReturn}
              className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium transition-colors hover:bg-surface-hover"
              style={{ color: "var(--text)" }}
            >
              {t("return")}
            </button>

            {playlist.isOwner && (
              <button
                onClick={onUnlikeAll}
```

Insert this between the closing `</button>` of Return and the `{playlist.isOwner && (` block:

```jsx
            {isAdmin && (
              <button
                onClick={() => setAutoPlayEnabled(!autoPlayEnabled)}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  autoPlayEnabled
                    ? "bg-primary text-white shadow-sm hover:bg-primary-hover"
                    : "border border-border bg-surface hover:bg-surface-hover"
                }`}
                style={autoPlayEnabled ? {} : { color: "var(--text)" }}
              >
                {autoPlayEnabled ? t("autoPlayOn") : t("autoPlayOff")}
              </button>
            )}

```

The button is visible to ADMIN regardless of `editMode` and `playlist.isOwner`, per the spec.

- [ ] **Step 4: Manually verify the toggle**

Start servers if not already running:
```
cd backend && npm run dev
cd frontend && npm run dev
```

In a browser:
1. Log in as an ADMIN user.
2. Navigate to any playlist (`/playlists/<id>`).
3. **Expected:** A button labelled "Auto-play: OFF" (or Chinese equivalent) appears in the top-right button row, with the bordered/outline style.
4. Click it. **Expected:** Label changes to "Auto-play: ON" with filled primary style.
5. Reload the page. **Expected:** Still "Auto-play: ON" (persistence working).
6. Click again to turn off. Reload. **Expected:** Stays "OFF".
7. Log out, log in as a non-admin (MEMBER) user. **Expected:** No auto-play button visible.

If any expectation fails, fix before committing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/playlist/PlaylistHeader.js
git commit -m "Add admin-only auto-play toggle to PlaylistHeader"
```

---

## Task 4: Add `onClipEnded` callback to useAudioPlayer

**Files:**
- Modify: `frontend/src/hooks/useAudioPlayer.js`

This task makes the hook *capable* of signaling natural end-of-clip but does not yet wire any consumer up. After this task, behavior is unchanged.

- [ ] **Step 1: Add `onClipEnded` to the props destructure**

Open `frontend/src/hooks/useAudioPlayer.js`. Current signature is:

```js
export default function useAudioPlayer({
  playerId,
  clipId,
  clipLength,
  clipVersion,
  speed = 1.0,
  pitch = 0,
}) {
```

Replace with:

```js
export default function useAudioPlayer({
  playerId,
  clipId,
  clipLength,
  clipVersion,
  speed = 1.0,
  pitch = 0,
  onClipEnded,
}) {
```

- [ ] **Step 2: Stabilize the callback in a ref**

The callback may be a fresh function each render. Stash it in a ref so the time-tracking loop and PitchShifter `onEnd` (both captured at play-time) see the latest version without re-creating the player.

Immediately after the existing `const playEpochRef = useRef(0);` line, add:

```js
  const onClipEndedRef = useRef(onClipEnded);
  useEffect(() => { onClipEndedRef.current = onClipEnded; }, [onClipEnded]);
```

- [ ] **Step 3: Invoke the callback in the time-tracking natural-end branch**

Find the `tick` function inside `startTimeTracking`. The current natural-end branch is:

```js
      if (time >= clipLength) {
        stopShifter();
        setCurrentTime(0);
        offsetRef.current = 0;
        setIsPlaying(false);
        return;
      }
```

Replace with:

```js
      if (time >= clipLength) {
        stopShifter();
        setCurrentTime(0);
        offsetRef.current = 0;
        setIsPlaying(false);
        onClipEndedRef.current?.();
        return;
      }
```

- [ ] **Step 4: Invoke the callback in the PitchShifter `onEnd` branch**

Find the `PitchShifter` `onEnd` callback inside `play`. Current:

```js
      const shifter = new PitchShifter(ctx, buffer, 4096, () => {
        // onEnd callback — only act if this shifter is still the active one
        if (shifterRef.current !== shifter) return;
        stopShifter();
        setCurrentTime(0);
        offsetRef.current = 0;
        setIsPlaying(false);
      });
```

Replace with:

```js
      const shifter = new PitchShifter(ctx, buffer, 4096, () => {
        // onEnd callback — only act if this shifter is still the active one
        if (shifterRef.current !== shifter) return;
        stopShifter();
        setCurrentTime(0);
        offsetRef.current = 0;
        setIsPlaying(false);
        onClipEndedRef.current?.();
      });
```

**Do NOT add this call** anywhere else. Specifically, leave these alone:
- `pause()` — must not fire on user pause.
- `stopShifter()` itself — called from many non-natural paths (active player change, seek, unmount, epoch invalidation). Inserting the callback there would fire on clip switching.
- The `useEffect` that handles `activePlayerId !== playerId` — that's the clip-switching path.
- The `seek()` restart path.
- The unmount cleanup.

Only the two natural-end paths above invoke it.

- [ ] **Step 5: Manually verify nothing regressed**

In the browser, open a playlist, play a clip, let it finish naturally. Expected: clip ends and stops as before (no consumer wired up yet, so no advance happens). Pause mid-clip works. Switching clips works. Seeking works. Console should be clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useAudioPlayer.js
git commit -m "Add onClipEnded callback to useAudioPlayer (natural end only)"
```

---

## Task 5: Wire next-clip advance into PlayerBox

**Files:**
- Modify: `frontend/src/components/player/PlayerBox.js`

- [ ] **Step 1: Add the `triggerPlayFromStart` and `autoPlayEnabled` selectors**

Open `frontend/src/components/player/PlayerBox.js`. Find this existing block near the top of the component body:

```js
  const playFromStartClipId = usePlayerStore((s) => s.playFromStartClipId);
  const clearPlayFromStart = usePlayerStore((s) => s.clearPlayFromStart);
  const isLiked = usePlayerStore((s) => s.isClipLiked(playlistId, clipId));
```

Replace with (adds two more selector reads):

```js
  const playFromStartClipId = usePlayerStore((s) => s.playFromStartClipId);
  const clearPlayFromStart = usePlayerStore((s) => s.clearPlayFromStart);
  const triggerPlayFromStart = usePlayerStore((s) => s.triggerPlayFromStart);
  const autoPlayEnabled = usePlayerStore((s) => s.autoPlayEnabled);
  const isLiked = usePlayerStore((s) => s.isClipLiked(playlistId, clipId));
```

- [ ] **Step 2: Define the `handleClipEnded` callback**

Immediately AFTER the `const playerId = \`${playlistId}-${clipId}\`;` line, but BEFORE the `useAudioPlayer` call, add:

```js
  const handleClipEnded = useCallback(() => {
    if (!autoPlayEnabled) return;
    if (!Array.isArray(allClips) || clipIndex == null) return;

    // Read latest likedClips imperatively — no subscription needed,
    // we only check at the moment a clip ends.
    const liked = usePlayerStore.getState().likedClips;

    for (let i = clipIndex + 1; i < allClips.length; i++) {
      const next = allClips[i];
      if (!next) continue;
      const key = `${playlistId}:${next.clipId}`;
      if (!liked.has(key)) {
        triggerPlayFromStart(next.clipId);
        return;
      }
    }
    // No eligible next clip — chain ends naturally.
  }, [autoPlayEnabled, allClips, clipIndex, playlistId, triggerPlayFromStart]);
```

- [ ] **Step 3: Pass `onClipEnded` into `useAudioPlayer`**

The current call is:

```js
  const {
    play,
    pause,
    seek,
    playFromStart,
    setVolume,
    setSpeed,
    currentTime,
    duration,
    isPlaying,
    volume,
  } = useAudioPlayer({
    playerId,
    clipId,
    clipLength: clip.length,
    clipVersion: clip.version,
    speed,
    pitch,
  });
```

Change the `useAudioPlayer({ ... })` argument to add `onClipEnded`:

```js
  } = useAudioPlayer({
    playerId,
    clipId,
    clipLength: clip.length,
    clipVersion: clip.version,
    speed,
    pitch,
    onClipEnded: handleClipEnded,
  });
```

- [ ] **Step 4: Manually verify the basic chain**

Browser steps as ADMIN:

1. Navigate to a playlist with at least 4 clips and toggle Auto-play: ON.
2. Click play on clip #1. Wait for it to end naturally. **Expected:** Clip #2 begins playing automatically from its start, with its own saved speed/pitch. Page does NOT scroll (per spec).
3. Let #2 finish. **Expected:** #3 starts.
4. Pause #3 mid-clip. **Expected:** Stays paused, no advance.
5. Resume #3 and let it finish. **Expected:** #4 starts (chain not broken by the pause).
6. While #4 plays, click play on #1. **Expected:** #1 plays from its start; #4 stops without advancing. When #1 ends naturally, #2 plays next (the chain continues from #1's position).
7. Toggle Auto-play: OFF. Play any clip and let it end. **Expected:** No advance — exactly the original behavior.

If any step fails, debug before continuing. The most likely root causes are: a missing dep in `useCallback`, the wrong index lookup, or `onClipEnded` being invoked from a non-natural path in Task 4.

- [ ] **Step 5: Manually verify skip-liked behavior**

1. Auto-play: ON. Like clip #2 (heart it so it shows the strikethrough/40%-opacity style).
2. Play clip #1, let it finish. **Expected:** #3 plays next, NOT #2.
3. Like all clips after the currently-playing one. Let the current clip finish. **Expected:** Playback ends silently — no advance.
4. Unlike one of them and start the chain again. **Expected:** Chain resumes correctly.
5. End-of-playlist test: play the second-to-last clip, let it finish. **Expected:** Last clip plays. When last clip ends, playback stops (no wraparound).

- [ ] **Step 6: Manually verify edit mode + auto-play coexistence**

1. Auto-play: ON. Click Edit. **Expected:** Edit mode UI appears; auto-play button still visible.
2. Play a clip; let it end. **Expected:** Chain still advances as in Step 4.
3. Click Edit again to exit. Auto-play state preserved.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/player/PlayerBox.js
git commit -m "Auto-advance to next non-liked clip when auto-play is enabled"
```

---

## Final Verification

Run through the full verification list from the spec one more time as a regression sweep:

- [ ] ADMIN sees toggle; MEMBER does not.
- [ ] Toggle state persists across reload and across different playlists.
- [ ] Basic chain: #1 → #2 → #3 with each clip's own speed/pitch.
- [ ] Skip liked: liked clips are jumped over; if all remaining are liked, playback stops.
- [ ] Pause does not break the chain — resume + natural end advances.
- [ ] Manual switch: clicking another clip mid-playback does not fire an advance from the first; the new clip's natural end does advance.
- [ ] Seek: seeking inside a clip does not fire advance.
- [ ] End of playlist: last eligible clip ends and stops with no wraparound.
- [ ] Auto-play OFF: behaves exactly like before this feature (regression check).
- [ ] Edit mode coexists with auto-play.
- [ ] No console errors during any of the above.

If everything passes, the feature is complete.
