# Playlist Activity Log (Admin) — Design

**Date:** 2026-07-01
**Status:** Approved design, pending implementation plan

## Goal

Add an admin-only view that records structural changes to all playlists across all
users: playlist creation, deletion, metadata edits, and clip-level changes
(add/remove/swap/reorder/comment/color). Likes are **not** treated as changes and are
never recorded.

The central challenge: users make frequent small edits. A flat "one row per action"
log would be unreadable. The log must stay organized and scannable.

## Solution summary

1. Store **atomic events** in a new `playlist_activity` table (one row per action),
   with denormalized snapshot labels so reads need no joins and survive deletion.
2. **Group at read time** into *sessions*: consecutive events by the same user on the
   same playlist within a 30-minute idle gap collapse into one expandable entry.
3. Render sessions as collapsible rows in a new admin page section.
4. Prune events older than 90 days via a script.

## What gets logged

Structural + selected customization events only:

| Action                  | Trigger                                    | `detail` label example                         |
| ----------------------- | ------------------------------------------ | ---------------------------------------------- |
| `PLAYLIST_CREATED`      | `createPlaylist`                           | `"Workout Mix"`                                |
| `PLAYLIST_DELETED`      | `deletePlaylist`                           | `"Workout Mix"`                                |
| `PLAYLIST_RENAMED`      | `updatePlaylist` (name changed)            | `"Old Name" → "New Name"`                      |
| `PLAYLIST_META_CHANGED` | `updatePlaylist` (description/isPublic)    | `description changed` / `made public`          |
| `CLIP_ADDED`            | `addClipToPlaylist`                        | `"Song A — Artist"`                            |
| `CLIP_REMOVED`          | `removeClipFromPlaylist`, `batchRemoveClips` | `"Song A — Artist"` (one event per clip)     |
| `CLIP_SWAPPED`          | `swapClip`                                 | `"Old Song" → "New Song"`                      |
| `CLIP_REORDERED`        | `reorderClips`                             | `"Song A — Artist" moved 3 → 7`                |
| `CLIP_COMMENT_CHANGED`  | `updateClipCustomization`, `batchUpdateClips` | `"Song A": "good chorus" → "great chorus"`  |
| `CLIP_COLOR_CHANGED`    | `updateClipCustomization`, `batchUpdateClips` | `"Song A": Blue → Purple`                   |
| `PLAYLIST_COPIED`       | `copyPlaylist`                             | `copied from "Original Name"`                  |

**Explicitly NOT logged:** likes, clip speed, clip pitch, section label, sharing /
copy-permission changes.

### Notes on specific events

- **Reorder** — `reorderClips(playlistId, clipIds)` receives the full new order. The
  service fetches the current order first, computes the **minimal-move diff** (the
  smallest set of clips whose relocation explains the new order — i.e. the clip(s) the
  user actually dragged), and logs one `CLIP_REORDERED` event per truly-moved clip with
  its old → new position. Clips that only shifted as a side effect are not logged.
- **Comment** — store old → new, each truncated to ~60 chars. Empty old = "(set)",
  empty new = "(cleared)".
- **Color** — stored as hex (`#8B6CC1`) possibly `|`-joined for multi-tags. Map known
  hex codes to color names (Purple, Blue, Orange/Amber, Coral, Red, Green, Yellow,
  Pink) for the label; fall back to raw hex if unknown.
- **Batch operations** (`batchUpdateClips`, `batchRemoveClips`) emit one event per
  affected clip that actually changed the comment or color (or was removed).

## Data model

New Prisma model + enum:

```prisma
enum PlaylistActivityAction {
  PLAYLIST_CREATED
  PLAYLIST_DELETED
  PLAYLIST_RENAMED
  PLAYLIST_META_CHANGED
  CLIP_ADDED
  CLIP_REMOVED
  CLIP_SWAPPED
  CLIP_REORDERED
  CLIP_COMMENT_CHANGED
  CLIP_COLOR_CHANGED
  PLAYLIST_COPIED
}

model PlaylistActivity {
  id           String   @id @default(uuid()) @db.Uuid
  playlistId   String?  @map("playlist_id") @db.Uuid   // nullable: survives deletion
  playlistName String   @map("playlist_name")          // snapshot at log time
  userId       String?  @map("user_id") @db.Uuid       // SetNull if user deleted
  userName     String   @map("user_name")              // snapshot at log time
  action       PlaylistActivityAction
  detail       String?                                  // human-readable label
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@index([userId, playlistId, createdAt])  // supports session grouping query
  @@index([createdAt])                       // supports pagination + pruning
  @@map("playlist_activity")
}
```

**Design decisions:**
- `playlistName`, `userName`, `detail` are **denormalized snapshots** captured when the
  event is written. Rationale: (a) the log stays correct after a playlist is renamed or
  deleted or a user is removed; (b) reads are a single flat query with no joins.
- No FK relations on `PlaylistActivity` to `Playlist`/`User` (only loose `userId` for
  optional filtering). This keeps the log independent — deleting a playlist does not
  cascade-delete its history.
- The composite index `[userId, playlistId, createdAt]` lets the grouping query pull an
  ordered stream cheaply.

Migration: `npx prisma migrate dev --name add_playlist_activity`.

## Writing events

New `backend/src/services/activityService.js`:

```js
// logActivity({ playlistId, playlistName, userId, userName, action, detail })
// - Fire-and-forget: wrapped so a logging failure never throws into the caller.
async function logActivity(entry) {
  try {
    await prisma.playlistActivity.create({ data: entry });
  } catch (err) {
    console.error('[activity] failed to log', entry.action, err.message);
  }
}
```

Plus label helpers kept here (colorName(hex), truncate(str, 60), diffReorder(old, new)).

**Threading the actor + name through:** the playlist mutation services currently do not
all receive `userId` or the playlist name. Each mutation function that logs will:
1. Accept the acting `userId` (already available in most route handlers via `req.user.id`).
2. Look up / already-have the playlist name and clip song title needed for the label.

Where a service already loads the playlist or clip (e.g. `swapClip`, `copyPlaylist`
load records), reuse that data. Where it does not (e.g. `updatePlaylist`,
`addClipToPlaylist`), add a minimal `select` for `name` / song `title`+`artist`. These
are cheap indexed lookups.

Route handlers in `routes/playlists.js` pass `req.user.id` and `req.user.username` into
the service calls. Both are already present on `req.user` (set from the JWT payload in
`authMiddleware`, `middleware/auth.js:25`) — no extra lookup needed for the actor.

`logActivity` is called **after** the mutation succeeds, so failed mutations produce no
log entry.

## Reading + session grouping

New service function `getPlaylistActivity({ cursor, limit })` in `activityService.js`,
exposed via `GET /api/admin/activity?cursor=<createdAt>&limit=20`.

### Grouping algorithm (read-time)

```
Input: events ordered by createdAt DESC (fetch a page + a small look-ahead buffer)
Group key: (userId, playlistId)
Rule: two events belong to the same session iff
      - same userId AND same playlistId, AND
      - gap between adjacent events (by time) <= 30 minutes
A gap > 30 min, or a change in user/playlist, starts a new session.
```

Because events are streamed newest-first, the backend walks the ordered list and
emits **session objects**:

```json
{
  "sessionId": "<first-event-id>",          // stable key for React
  "userName": "alice",
  "playlistName": "Workout Mix",
  "playlistId": "…",                          // null if playlist deleted
  "startedAt": "2026-06-30T14:14:00Z",
  "endedAt":   "2026-06-30T14:31:00Z",
  "summary": { "added": 3, "removed": 1, "renamed": 1, "reordered": 0, ... },
  "eventCount": 5,
  "events": [
    { "action": "CLIP_ADDED", "detail": "Blinding Lights — The Weeknd", "createdAt": "…" },
    …
  ]
}
```

`summary` is a per-action count map used to render the collapsed one-line summary.

### Pagination

Cursor-based on `createdAt` (matching the existing songs pagination pattern). A session
that straddles a page boundary is handled by fetching a small look-ahead so the session
is complete; the returned `nextCursor` is the `createdAt` of the oldest event *not* yet
consumed. Simpler acceptable fallback if look-ahead proves fiddly: paginate by events
and allow a session to be split across "Load more" clicks (documented tradeoff — pick
during implementation, default to look-ahead).

## Admin UI

New collapsible section on `frontend/src/app/admin/page.js`, styled like the existing
sections (rounded bordered card, colored dot, count badge). New component
`frontend/src/components/admin/ActivityPanel.js`.

- Fetches `GET /api/admin/activity` on mount.
- Renders each session as a **collapsed row**:
  `alice · "Workout Mix" · Jun 30, 2:14–2:31 PM · +3 −1 clips, renamed`
- Clicking a row **expands** to the named-entity event list:
  ```
  + Added "Blinding Lights — The Weeknd"
  + Added "Levitating — Dua Lipa"
  − Removed "Old Song — Artist"
  ✎ Renamed to "Workout Mix"
  ↕ "Song A — Artist" moved 3 → 7
  ```
- **"Load more"** button appends the next page (cursor-based).
- New i18n keys for all labels (English + existing second language), following the
  `useLanguage()` / `t(...)` pattern already in the admin page.

Backend route: add `GET /api/admin/activity` to `routes/admin.js` (already behind
`requireRole('ADMIN')`), delegating to `activityService.getPlaylistActivity`.

## Retention

`backend/scripts/prune-activity.js`, modeled on `scripts/cleanup-clips.js`:

```
Deletes playlist_activity rows where createdAt < now() - 90 days.
Supports --dry-run. Prints count deleted.
```

Run manually (`node scripts/prune-activity.js`) or wire into a scheduled job later.
Scheduling is out of scope for this change; the script existing is sufficient.

## Testing

- **Unit** — `diffReorder(old, new)` minimal-move logic (the trickiest piece): single
  drag up, single drag down, no-op, multiple independent moves. `colorName(hex)` mapping
  incl. multi-tag and unknown-hex fallback. `truncate`.
- **Session grouping** — given a synthetic ordered event list, assert correct session
  boundaries (gap > 30 min splits; user change splits; playlist change splits).
- **Integration** — perform each mutation via the service layer and assert exactly the
  expected `playlist_activity` rows appear (and that likes produce none).
- **Manual** — exercise the admin panel: create/edit/reorder a playlist, confirm one
  clean session row with correct expand detail.

## Out of scope

- Logging likes, speed, pitch, section-label, or sharing changes.
- Per-user activity views or activity on the non-admin UI.
- Automated scheduling of the prune script.
- Real-time updates (admin refreshes to see new activity).
```
