# Copy your own playlist — design

## Goal

Allow a playlist owner to duplicate one of their own playlists in one click. The duplicate is a private, independently-editable copy that preserves all clips and per-clip customizations.

## Use cases

- **Variation** — duplicate, then tweak (different speeds/pitches, reorder, remove some clips) without losing the original.
- **Backup/snapshot** — preserve current state before making large changes.

## Current state

A copy feature already exists for non-owners with copy permission:

- Service: `copyPlaylist(playlistId, userId)` in [backend/src/services/playlistService.js](../../../backend/src/services/playlistService.js) creates a new playlist named `Copy of <name>`, `isPublic: false`, and clones every `playlistClip` with `speed`, `pitch`, `colorTag`, `comment`, `sectionLabel`, and `position` intact.
- Route: `POST /api/playlists/:id/copy` in [backend/src/routes/playlists.js](../../../backend/src/routes/playlists.js) gates on `req.playlistAccess.canCopy`.
- Frontend: `handleCopy` in [frontend/src/app/playlists/[id]/page.js](../../../frontend/src/app/playlists/[id]/page.js) calls the API and redirects to the new playlist; the "Copy Playlist" button in [frontend/src/components/playlist/PlaylistHeader.js](../../../frontend/src/components/playlist/PlaylistHeader.js) is rendered only when `!playlist.isOwner && playlist.canCopy`.

Two small changes make this work for the owner case too.

## Changes

### 1. Backend — `playlistAccess` middleware

[backend/src/middleware/playlistAccess.js:36](../../../backend/src/middleware/playlistAccess.js#L36) currently sets:

```js
canCopy = playlist.isPublic || (canCopy && canView);
```

This excludes owners (an owner has no row in `copyPermissions` for their own playlist, and a private owner-only playlist is not `isPublic`). The route therefore returns 403 if the owner tries to copy their own private playlist.

Fix:

```js
canCopy = isOwner || playlist.isPublic || (canCopy && canView);
```

No new route, no new service.

### 2. Frontend — Copy button visibility

[frontend/src/components/playlist/PlaylistHeader.js:188](../../../frontend/src/components/playlist/PlaylistHeader.js#L188) currently renders:

```jsx
{!playlist.isOwner && playlist.canCopy && (
  <button onClick={onCopy} ...>{t("copyPlaylist")}</button>
)}
```

Change the condition so owners also see the button:

```jsx
{(playlist.isOwner || playlist.canCopy) && (
  <button onClick={onCopy} ...>{t("copyPlaylist")}</button>
)}
```

The existing i18n string `copyPlaylist` ("Copy Playlist" / "复制列表") reads correctly for the owner case.

### 3. Frontend — handler

No change. `handleCopy` in `app/playlists/[id]/page.js` already calls `playlistsAPI.copy(id)` and navigates to the new playlist. It works for owners as soon as the backend returns 201 instead of 403.

## What is NOT copied (intentional)

- **Likes** — likes are keyed on `(playlistId, clipId)` and are user-personal; the new copy starts with zero likes. This matches existing copy semantics.
- **Shares / copy permissions** — the new playlist is private to its new owner with no shares or copy permissions. Correct default for both variation and backup.

## What IS copied

- Name (prefixed `Copy of `)
- Description
- All `playlistClip` rows in original order, each with: `clipId`, `position`, `speed`, `pitch`, `colorTag`, `comment`, `sectionLabel`

## Out of scope

- Copy button on the playlist grid cards (`/playlists` listing). User chose detail-page-only placement.
- Renaming the copy at creation time. The user can rename via the existing edit UI.
- Configuring whether the copy is public. User can change via the existing share UI.

## Manual test plan

1. As an owner, create a playlist with several clips. Customize at least one clip's speed, pitch, colorTag, and comment.
2. Open the playlist detail page. Confirm a "Copy Playlist" button appears next to Share/Edit.
3. Click Copy. Confirm:
   - Redirect to the new playlist's detail page.
   - New playlist name is `Copy of <original>`.
   - Clip order matches the original.
   - Per-clip customizations (speed, pitch, colorTag, comment, sectionLabel) match the original.
   - New playlist is private (`isPublic: false`) with no shares and no copy permissions.
4. Open the original playlist. Confirm it is unchanged.
5. As a non-owner without copy permission, confirm the Copy button still does not appear (regression check on the visibility condition).
