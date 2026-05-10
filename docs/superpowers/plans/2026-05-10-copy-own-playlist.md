# Copy Your Own Playlist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a playlist owner duplicate one of their own playlists from the playlist detail page.

**Architecture:** The backend `copyPlaylist` service and `POST /api/playlists/:id/copy` route already exist and work for owners — except the `playlistAccess` middleware excludes owners from `canCopy`, causing a 403. Fix the middleware, then change one visibility condition on the frontend "Copy Playlist" button so it also renders for owners. No new routes, services, or i18n strings.

**Tech Stack:** Express.js (backend middleware), React + Next.js App Router (frontend), Prisma (untouched), Zustand (untouched).

**Spec:** [`docs/superpowers/specs/2026-05-10-copy-own-playlist-design.md`](../specs/2026-05-10-copy-own-playlist-design.md)

---

## File Structure

- **Modify** `backend/src/middleware/playlistAccess.js` — include `isOwner` in the `canCopy` derivation so the existing copy route accepts owner requests.
- **Modify** `frontend/src/components/playlist/PlaylistHeader.js` — change the Copy button's render condition from `!playlist.isOwner && playlist.canCopy` to `(playlist.isOwner || playlist.canCopy)`.

No test files. The project has no frontend test suite, and `backend/tests/` is a manual smoke-test directory (`db-summary.js`, `e2e-test.js`) — not an automated suite to extend for a one-line middleware fix. Verification is manual per the spec's test plan.

---

## Task 1: Backend — allow owners to copy their own playlist

**Files:**
- Modify: `backend/src/middleware/playlistAccess.js:36`

- [ ] **Step 1: Read the current middleware to confirm the line number**

Run: open `backend/src/middleware/playlistAccess.js` and locate line 36. It should currently read:

```js
canCopy = playlist.isPublic || (canCopy && canView);
```

If the line has drifted, locate the equivalent assignment inside `playlistAccess` after the `canEdit` declaration.

- [ ] **Step 2: Apply the edit**

Change the assignment to include `isOwner`:

```js
canCopy = isOwner || playlist.isPublic || (canCopy && canView);
```

Full context for the edit (surrounding lines unchanged) — old:

```js
    const isOwner = playlist.userId === userId;
    const isShared = playlist.shares.length > 0;
    let canCopy = playlist.copyPermissions.length > 0;

    const canView = isOwner || isShared || canCopy || playlist.isPublic;
    const canEdit = isOwner;

    // Public playlists are always copyable; otherwise need explicit copy permission + view access
    canCopy = playlist.isPublic || (canCopy && canView);
```

new:

```js
    const isOwner = playlist.userId === userId;
    const isShared = playlist.shares.length > 0;
    let canCopy = playlist.copyPermissions.length > 0;

    const canView = isOwner || isShared || canCopy || playlist.isPublic;
    const canEdit = isOwner;

    // Owners can always copy their own playlist; public playlists are always copyable;
    // otherwise need explicit copy permission + view access.
    canCopy = isOwner || playlist.isPublic || (canCopy && canView);
```

- [ ] **Step 3: Restart the backend dev server**

Stop the running backend (Ctrl-C in its terminal, or on Windows `taskkill /F /IM node.exe` if it is detached) and run:

```
cd backend
npm run dev
```

Expected: server logs `Server listening on http://localhost:4000` (or equivalent) with no errors.

- [ ] **Step 4: Smoke-test the route as an owner**

With the backend running and frontend running (`cd frontend && npm run dev`), log in as a user who owns at least one private playlist. In a browser devtools console on `http://localhost:3000`, run:

```js
fetch('/api/playlists/<OWNED_PRIVATE_PLAYLIST_ID>/copy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
}).then(r => r.json()).then(console.log)
```

Replace `<OWNED_PRIVATE_PLAYLIST_ID>` with the id from the URL when viewing the playlist.

Expected: response is a playlist object whose `name` starts with `Copy of ` and whose `userId` matches the logged-in user. Before this change the same request would return `{ error: { message: 'Forbidden', status: 403 } }`.

Clean up: delete the test copy via the UI (Edit → Delete on the new playlist) before continuing.

- [ ] **Step 5: Commit**

```
git add backend/src/middleware/playlistAccess.js
git commit -m "Allow owners to copy their own playlist"
```

---

## Task 2: Frontend — show Copy button for owners

**Files:**
- Modify: `frontend/src/components/playlist/PlaylistHeader.js:188`

- [ ] **Step 1: Locate the existing Copy button block**

Open `frontend/src/components/playlist/PlaylistHeader.js`. Around line 188 you should see:

```jsx
{!playlist.isOwner && playlist.canCopy && (
  <button
    onClick={onCopy}
    className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium hover:bg-surface-hover"
    style={{ color: "var(--text)" }}
  >
    {t("copyPlaylist")}
  </button>
)}
```

- [ ] **Step 2: Update the visibility condition**

Change the surrounding condition only. The button markup itself is unchanged.

new:

```jsx
{(playlist.isOwner || playlist.canCopy) && (
  <button
    onClick={onCopy}
    className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium hover:bg-surface-hover"
    style={{ color: "var(--text)" }}
  >
    {t("copyPlaylist")}
  </button>
)}
```

Note: `handleCopy` in `frontend/src/app/playlists/[id]/page.js` (passed to `PlaylistHeader` as `onCopy`) and `playlistsAPI.copy` in `frontend/src/lib/api.js` are already wired up and need no changes.

- [ ] **Step 3: Verify the dev server picks up the change**

With `cd frontend && npm run dev` running, watch the terminal for a successful HMR recompile after saving. No type errors expected (project uses plain JS).

- [ ] **Step 4: Manual UI test — owner copy flow**

In the browser:

1. Log in as a playlist owner. Open a playlist you own. Confirm a "Copy Playlist" button appears next to "Share" and "Edit".
2. Pick a clip in the playlist and (in Edit mode) set a non-default speed, pitch, a color tag, and a comment. Save.
3. Click "Copy Playlist". Confirm:
   - The page navigates to a new playlist URL (`/playlists/<new-id>`).
   - The new playlist's title is `Copy of <original>`.
   - The clip you customized has the same speed, pitch, color tag, and comment.
   - The new playlist is private (open Share modal — `isPublic` is off, shares list is empty, copy permissions list is empty).
4. Navigate back to the original playlist. Confirm it is unchanged (same name, same customizations, still has its original shares/copy permissions if any).

- [ ] **Step 5: Manual UI regression test — non-owner without copy permission**

Log in as a different user who has neither owner nor copy permission on some playlist (any playlist not shared with them with copy rights). Open it via a direct share link or admin browsing. Confirm the "Copy Playlist" button does NOT appear.

- [ ] **Step 6: Commit**

```
git add frontend/src/components/playlist/PlaylistHeader.js
git commit -m "Show Copy Playlist button to playlist owners"
```

---

## Self-Review

**1. Spec coverage**

- Goal "owner can copy their own playlist via detail-page button": covered by Task 1 (backend allow) + Task 2 (frontend show).
- Behavior "reuses `copyPlaylist` service unchanged": no service edits scheduled. Confirmed.
- "Likes/shares/copy-permissions not copied": no change to `copyPlaylist` so existing semantics hold.
- "After copy, frontend redirects to new playlist": handled by existing `handleCopy` (verified at `app/playlists/[id]/page.js:203-206`). No change needed.
- "Default privacy `isPublic: false`": already the case in `copyPlaylist`. No change.
- Manual test plan from spec: covered by Task 2 Step 4 (owner flow) and Step 5 (non-owner regression).
- Out of scope items (grid card button, rename-at-create, publish-at-create): not in the plan. Correct.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", "add appropriate X", or "similar to Task N" found. Every step shows the exact code, command, or check.

**3. Type / name consistency**

- `playlist.isOwner` and `playlist.canCopy` — both already used in the existing condition; confirmed consistent.
- `req.playlistAccess.canCopy` — already consumed by `POST /:id/copy` route in `backend/src/routes/playlists.js:631`. The middleware fix makes it true for owners; route logic is untouched.
- `onCopy` prop and `handleCopy` callback — names match across `PlaylistHeader.js` and `app/playlists/[id]/page.js`.
- `playlistsAPI.copy` — already exists in `frontend/src/lib/api.js:130`.

No inconsistencies found.
