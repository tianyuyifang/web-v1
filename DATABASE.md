# Database Design

## Overview

PostgreSQL database with full Unicode/Chinese support, pinyin-based search (fuzzy, full pinyin, pinyin initials) across 400+ songs (expandable). Uses `pg_trgm` for fuzzy matching and pre-computed pinyin columns for fast Chinese search.

**Clips** are the playable unit in playlists. A clip is a fixed-length segment (20 seconds) of a song, defined by a start time. Songs are imported first without clips; users clip them later. Playlists contain clips, and likes target clips.

**Access control** is managed via the `role` column on `users`: new accounts are `PENDING` until an admin approves them. There is no email field — users are identified by username only. 9 tables total (no `password_reset_tokens`).

---

## Character Encoding

- Database encoding: **UTF-8** (`CREATE DATABASE music_app ENCODING 'UTF8' LC_COLLATE 'zh_CN.UTF-8' LC_CTYPE 'zh_CN.UTF-8'`)
- All text columns (`title`, `artist`, `name`, etc.) store Chinese/Unicode natively — no special column type needed, PostgreSQL `TEXT` handles it
- If `zh_CN.UTF-8` locale is unavailable on your system, use `en_US.UTF-8` — it still stores Chinese correctly, only sort order differs

---

## Required PostgreSQL Extensions

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";   -- UUID generation
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- Trigram fuzzy search (LIKE, similarity)
```

---

## Tables

### users

No email field — users are identified by username only. New accounts start as `PENDING` and must be approved by an admin before they can access the app. Admin accounts are seeded via `node scripts/seed-admins.js`.

| Role | Description |
|------|-------------|
| `PENDING` | Self-registered; no app access until approved |
| `MEMBER` | Approved by admin; full app access |
| `ADMIN` | Can manage users (approve, demote, delete); seeded via script |

```sql
CREATE TYPE role AS ENUM ('PENDING', 'MEMBER', 'ADMIN');

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          role NOT NULL DEFAULT 'PENDING',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### songs

Songs are the source material. They are imported from MP3 files and may or may not have clips yet.

```sql
CREATE TABLE songs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Core metadata
  title         TEXT NOT NULL,                -- Chinese or English, e.g. "月亮代表我的心"
  artist        TEXT NOT NULL,                -- Multiple artists joined with "_", e.g. "邓丽君" or "周杰伦_费玉清"
  duration      INTEGER,                      -- Duration in seconds
  file_path     TEXT NOT NULL,                -- e.g. "月亮代表我的心 - 邓丽君.mp3"
  lyrics        TEXT,                         -- LRC format, nullable
  starts        TEXT,                         -- Pipe-delimited clip start times, e.g. "0|25|50|75", nullable (no clips yet)

  -- Pre-computed pinyin columns (populated at import time)
  title_pinyin          TEXT,                 -- Full pinyin: "yue liang dai biao wo de xin"
  title_pinyin_initials TEXT,                 -- Initials only: "yldbwdx"
  artist_pinyin         TEXT,                 -- Full pinyin: "deng li jun" or "zhou jie lun_fei yu qing"
  artist_pinyin_initials TEXT,                -- Initials: "dlj" or "zjl_fyq"

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Why pre-computed pinyin?**

- Converting 200k titles/artists to pinyin at query time is too slow
- Pre-computing at import time makes search a simple string comparison
- The pinyin columns add ~50-100 bytes per row — negligible at 200k rows

### song_artists (normalized artist lookup)

Since a song can have multiple artists separated by `_`, and searching by any single artist must work, we use a junction table for fast per-artist lookups.

```sql
CREATE TABLE song_artists (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  song_id   UUID NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  artist_name             TEXT NOT NULL,      -- Individual artist: "周杰伦"
  artist_pinyin           TEXT,               -- "zhou jie lun"
  artist_pinyin_initials  TEXT,               -- "zjl"
  position  INTEGER NOT NULL DEFAULT 0        -- Order of artist (0 = primary)
);

CREATE INDEX idx_song_artists_song_id ON song_artists(song_id);
CREATE INDEX idx_song_artists_name_trgm ON song_artists USING GIN (artist_name gin_trgm_ops);
CREATE INDEX idx_song_artists_pinyin_trgm ON song_artists USING GIN (artist_pinyin gin_trgm_ops);
CREATE INDEX idx_song_artists_initials ON song_artists(artist_pinyin_initials);
```

**How it works at import:**

- For a song with `artist = "周杰伦_费玉清"`, insert two rows into `song_artists`:
  - `{ song_id, artist_name: "周杰伦", artist_pinyin: "zhou jie lun", artist_pinyin_initials: "zjl", position: 0 }`
  - `{ song_id, artist_name: "费玉清", artist_pinyin: "fei yu qing", artist_pinyin_initials: "fyq", position: 1 }`
- Searching for "周杰伦" or "zjl" finds all songs with that artist, even multi-artist songs

### clips

A clip is a fixed-length segment (20 seconds) of a song. Clips are created by users after songs are imported — a song may have zero clips initially. Each clip plays from `start` for `length` seconds (or until the song ends, whichever comes first).

```sql
CREATE TABLE clips (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  song_id   UUID NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  start     INTEGER NOT NULL,                 -- Start time in seconds
  length    INTEGER NOT NULL DEFAULT 20,      -- Clip duration: fixed at 20 seconds
  lyrics    TEXT,                             -- LRC lyrics sliced from song.lyrics for this clip's time range

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(song_id, start)                      -- One clip per start time per song
);

CREATE INDEX idx_clips_song_id ON clips(song_id);
```

**Key points:**

- Songs are imported without clips — clips are user-created later
- A song can have many clips at different start times (e.g., a 4-minute song might have clips at 0s, 25s, 50s, 75s, etc.)
- Fixed length of 20 seconds; playback stops at `start + length` or song end
- `UNIQUE(song_id, start)` prevents duplicate clips at the same start time
- Searching for clips is done through the parent song (JOIN through `song_id` to access title, artist, pinyin columns)
- Deleting a song cascades to delete all its clips → which cascades to remove them from all playlists and likes

### playlists

```sql
CREATE TABLE playlists (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  is_public   BOOLEAN NOT NULL DEFAULT false,

  -- Pre-computed pinyin for playlist name search
  name_pinyin           TEXT,                 -- "wo de ge dan"
  name_pinyin_initials  TEXT,                 -- "wdgd"

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_playlists_user_id ON playlists(user_id);
CREATE INDEX idx_playlists_public ON playlists(is_public) WHERE is_public = true;
CREATE INDEX idx_playlists_name_trgm ON playlists USING GIN (name gin_trgm_ops);
CREATE INDEX idx_playlists_name_pinyin_trgm ON playlists USING GIN (name_pinyin gin_trgm_ops);
CREATE INDEX idx_playlists_name_pinyin_initials ON playlists(name_pinyin_initials);
```

### playlist_shares

Allows the playlist owner to share a playlist with specific users. Shared users can view and play the playlist but cannot edit it (only the owner can). This is separate from `is_public` — a private playlist can be shared with select users.

```sql
CREATE TABLE playlist_shares (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(playlist_id, user_id)                   -- Can only share with a user once
);

CREATE INDEX idx_playlist_shares_playlist ON playlist_shares(playlist_id);
CREATE INDEX idx_playlist_shares_user ON playlist_shares(user_id);
```

### playlist_copy_permissions

Separate from sharing — the owner can grant specific users the ability to copy the playlist. A user can have share access, copy access, both, or neither. Copy permission does not require share access (e.g., a public playlist viewer can be granted copy permission).

```sql
CREATE TABLE playlist_copy_permissions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(playlist_id, user_id)                   -- Can only grant copy permission once per user
);

CREATE INDEX idx_playlist_copy_perms_playlist ON playlist_copy_permissions(playlist_id);
CREATE INDEX idx_playlist_copy_perms_user ON playlist_copy_permissions(user_id);
```

**Access levels (share and copy are independent per-user grants):**
| Permission | How granted | What user can do |
|-----------|------------|-----------------|
| Share only | Row in `playlist_shares` | View and play the playlist (even if private) |
| Copy only | Row in `playlist_copy_permissions` | Copy the playlist (must also have view access — via share or `is_public`) |
| Share + Copy | Rows in both tables | View, play, and copy |
| Neither | No rows | Only sees it if `is_public = true` (view/play only, no copy) |

**Managing shares:**

```javascript
// Owner shares playlist with another user (view access)
// POST /api/playlists/:id/shares { userId }
await prisma.playlistShare.create({
  data: { playlistId, userId: targetUserId },
});

// Owner removes a share
// DELETE /api/playlists/:id/shares/:userId
await prisma.playlistShare.delete({
  where: { playlistId_userId: { playlistId, userId: targetUserId } },
});

// Get all users this playlist is shared with
// GET /api/playlists/:id/shares
const shares = await prisma.playlistShare.findMany({
  where: { playlistId },
  include: { user: { select: { id: true, username: true } } },
});
```

**Managing copy permissions:**

```javascript
// Owner grants copy permission to a user
// POST /api/playlists/:id/copy-permissions { userId }
await prisma.playlistCopyPermission.create({
  data: { playlistId, userId: targetUserId },
});

// Owner revokes copy permission
// DELETE /api/playlists/:id/copy-permissions/:userId
await prisma.playlistCopyPermission.delete({
  where: { playlistId_userId: { playlistId, userId: targetUserId } },
});

// Get all users with copy permission
// GET /api/playlists/:id/copy-permissions
const copyPerms = await prisma.playlistCopyPermission.findMany({
  where: { playlistId },
  include: { user: { select: { id: true, username: true } } },
});
```

**Copying a playlist:**

```javascript
// User copies a playlist they have copy permission for
// POST /api/playlists/:id/copy
// Backend checks:
//   1. User has a row in playlist_copy_permissions for this playlist
//   2. User has view access (shared with them OR playlist is public)
const original = await prisma.playlist.findUnique({
  where: { id: playlistId },
  include: { playlistClips: true },
});

const copied = await prisma.playlist.create({
  data: {
    userId: currentUserId,              // Caller becomes the owner
    name: `Copy of ${original.name}`,
    description: original.description,
    isPublic: false,                    // Copied playlist starts as private
    namePinyin: original.namePinyin,
    namePinyinInitials: original.namePinyinInitials,
    playlistClips: {
      create: original.playlistClips.map((pc) => ({
        clipId: pc.clipId,
        position: pc.position,
        speed: pc.speed,
        pitch: pc.pitch,
        colorTag: pc.colorTag,
        comment: pc.comment,
      })),
    },
  },
});
// The copied playlist is fully independent — no link to the original
```

### playlist_clips

Playlists contain clips (not songs directly). The same song can appear multiple times as different clips. Each entry carries per-user customization for how the clip plays within this playlist.

```sql
CREATE TABLE playlist_clips (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  clip_id     UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,

  -- Per-clip customization within this playlist
  speed       REAL NOT NULL DEFAULT 1.0,      -- Playback speed: 1.0 = normal, 1.1 = 10% faster, 0.9 = 10% slower
  pitch       INTEGER NOT NULL DEFAULT 0,     -- Pitch shift in semitones: 0 = original key, +4 = up 4, -4 = down 4
  color_tag   TEXT,                           -- Hex color for custom categorization, e.g. "#FF5733", nullable
  comment     TEXT,                           -- User's note/comment on this clip, nullable

  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(playlist_id, clip_id)               -- Prevent duplicate clips within a playlist
);

CREATE INDEX idx_playlist_clips_playlist ON playlist_clips(playlist_id, position);
CREATE INDEX idx_playlist_clips_clip ON playlist_clips(clip_id);
CREATE INDEX idx_playlist_clips_color ON playlist_clips(playlist_id, color_tag) WHERE color_tag IS NOT NULL;
```

**Customization fields:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `speed` | REAL | 1.0 | Playback rate. Range: 0.5–2.0. Applied via `audio.playbackRate` in the frontend |
| `pitch` | INTEGER | 0 | Semitone shift. Range: -12 to +12. Requires Web Audio API `PitchShifter` or similar |
| `color_tag` | TEXT | NULL | Hex color string for visual categorization (e.g. red = high energy, blue = calm) |
| `comment` | TEXT | NULL | Free-text note the user attaches to this clip in this playlist |

### likes

Likes are scoped to a **clip within a playlist** — a user likes a specific clip in a specific playlist.

```sql
CREATE TABLE likes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  clip_id     UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, playlist_id, clip_id)          -- One like per user per clip per playlist
);

-- For "get all clips this user has liked in a specific playlist"
CREATE INDEX idx_likes_user_playlist ON likes(user_id, playlist_id);

-- For "get all clips this user has liked across all playlists"
CREATE INDEX idx_likes_user_clips ON likes(user_id);
```

**Notes:**

- A user can like the same clip in different playlists independently
- `UNIQUE(user_id, playlist_id, clip_id)` prevents duplicate likes

**Deletion & cascade behavior:**

| Action                        | What cascades automatically                                                                                                                                                   | What needs manual cleanup                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Delete a playlist             | `playlist_clips`, `playlist_shares`, `playlist_copy_permissions`, `likes` referencing that playlist removed                                                                    | Nothing — fully cascaded                                                   |
| Remove a clip from a playlist | Only the `playlist_clips` row is deleted                                                                                                                                      | `likes` where `playlist_id` + `clip_id` match — must be deleted in backend |
| Delete a clip                 | `playlist_clips` rows removed, `likes` referencing that clip removed                                                                                                          | Nothing — fully cascaded                                                   |
| Delete a song                 | All its `clips` cascade-deleted → all `playlist_clips` and `likes` for those clips removed; `song_artists` removed                                                            | Nothing — fully cascaded                                                   |
| Delete a user                 | All their `playlists` → cascades to `playlist_clips`, `playlist_shares`, `playlist_copy_permissions`, and `likes`; all their `likes` removed; all `playlist_shares` and `playlist_copy_permissions` where they are the target user removed | Nothing — fully cascaded                                                   |

Backend must handle the manual cleanup when removing a clip from a playlist:

```sql
-- Step 1: Remove clip-in-playlist likes for this user
DELETE FROM likes
WHERE playlist_id = :playlistId AND clip_id = :clipId AND user_id = :userId;

-- Step 2: Remove the clip from the playlist
DELETE FROM playlist_clips
WHERE playlist_id = :playlistId AND clip_id = :clipId;
```

---

## Entity Relationships

```
songs ──1:N──→ clips ──N:M──→ playlists ──N:M──→ users (shares)
  │               │                │         │
  1:N             │                │         1:N
  ↓               ↓                ↓         ↓
song_artists  playlist_clips     likes   playlist_shares
                  │            (clip-in-       │
                  └───────────→  playlist)     │
                                         playlist_copy_permissions
```

- `songs` → `clips`: one song has zero or many clips (created by users later)
- `clips` → `playlists`: many-to-many through `playlist_clips`
- `playlists` → `users`: many-to-many through `playlist_shares` (view access) and `playlist_copy_permissions` (copy access) — these are independent per-user grants
- `likes` reference a specific `clip` within a specific `playlist` (no playlist-level likes)
- Searching always goes through `songs` (title/artist/pinyin), then resolves to their clips

---

## Indexes for Search

### Song search indexes

```sql
-- Fuzzy Chinese title search
CREATE INDEX idx_songs_title_trgm ON songs USING GIN (title gin_trgm_ops);

-- Pinyin search on title
CREATE INDEX idx_songs_title_pinyin_trgm ON songs USING GIN (title_pinyin gin_trgm_ops);

-- Pinyin initials on title (exact prefix match, B-tree is fine)
CREATE INDEX idx_songs_title_pinyin_initials ON songs(title_pinyin_initials);

-- Artist column fuzzy (for the combined string)
CREATE INDEX idx_songs_artist_trgm ON songs USING GIN (artist gin_trgm_ops);
```

### Playlist search indexes

Already defined above in the `playlists` table section.

---

## Search Strategy

All search inputs go through the same logic: detect the type of query, then hit the right columns.

### Query type detection (done in backend JavaScript)

```
Input: "zjl"
  → All ASCII lowercase, no spaces → likely pinyin initials
  → Search: title_pinyin_initials LIKE 'zjl%' OR artist_pinyin_initials via song_artists

Input: "zhou jie"
  → ASCII with spaces → likely full pinyin
  → Search: title_pinyin ILIKE '%zhou jie%' OR artist_pinyin via song_artists

Input: "月亮"
  → Contains CJK characters → Chinese fuzzy
  → Search: title ILIKE '%月亮%' OR artist_name via song_artists (with pg_trgm)

Input: "yueli"
  → ASCII no spaces but long → could be pinyin without spaces
  → Search: title_pinyin ILIKE '%yueli%' (trigram handles partial matches)
```

### Search query examples

**1. User searches songs to clip and add to playlists (global song search)**

Search returns songs with their available clips. Songs without clips can be clipped first.

```sql
-- Pinyin initials search (fastest, prefix match)
-- Returns songs with their clips (if any)
SELECT s.*, c.id AS clip_id, c.start AS clip_start, c.length AS clip_length
FROM songs s
LEFT JOIN clips c ON c.song_id = s.id
WHERE s.title_pinyin_initials LIKE :query || '%'
UNION
SELECT s.*, c.id AS clip_id, c.start AS clip_start, c.length AS clip_length
FROM songs s
LEFT JOIN clips c ON c.song_id = s.id
JOIN song_artists sa ON sa.song_id = s.id
WHERE sa.artist_pinyin_initials LIKE :query || '%'
LIMIT 50;

-- Full pinyin fuzzy
SELECT s.*, c.id AS clip_id, c.start AS clip_start, c.length AS clip_length
FROM songs s
LEFT JOIN clips c ON c.song_id = s.id
WHERE s.title_pinyin % :query
   OR s.title_pinyin ILIKE '%' || :query || '%'
UNION
SELECT s.*, c.id AS clip_id, c.start AS clip_start, c.length AS clip_length
FROM songs s
LEFT JOIN clips c ON c.song_id = s.id
JOIN song_artists sa ON sa.song_id = s.id
WHERE sa.artist_pinyin % :query
   OR sa.artist_pinyin ILIKE '%' || :query || '%'
LIMIT 50;

-- Chinese character fuzzy
SELECT s.*, c.id AS clip_id, c.start AS clip_start, c.length AS clip_length
FROM songs s
LEFT JOIN clips c ON c.song_id = s.id
WHERE s.title % :query
   OR s.title ILIKE '%' || :query || '%'
UNION
SELECT s.*, c.id AS clip_id, c.start AS clip_start, c.length AS clip_length
FROM songs s
LEFT JOIN clips c ON c.song_id = s.id
JOIN song_artists sa ON sa.song_id = s.id
WHERE sa.artist_name % :query
   OR sa.artist_name ILIKE '%' || :query || '%'
LIMIT 50;
```

**2. User searches playlists (own + shared + public)**

```sql
SELECT p.* FROM playlists p
LEFT JOIN playlist_shares ps ON ps.playlist_id = p.id AND ps.user_id = :userId
WHERE (p.user_id = :userId OR ps.id IS NOT NULL OR p.is_public = true)
  AND (
    p.name ILIKE '%' || :query || '%'                     -- Chinese fuzzy
    OR p.name_pinyin ILIKE '%' || :query || '%'           -- Full pinyin
    OR p.name_pinyin_initials LIKE :query || '%'          -- Pinyin initials
  )
ORDER BY
  CASE WHEN p.user_id = :userId THEN 0                    -- Own playlists first
       WHEN ps.id IS NOT NULL THEN 1                      -- Shared playlists second
       ELSE 2 END,                                        -- Public playlists last
  p.name
LIMIT 50;
```

**3. User searches within a specific playlist**

Search goes through `playlist_clips` → `clips` → `songs` to match by song title/pinyin.

```sql
SELECT s.*, c.id AS clip_id, c.start AS clip_start, c.length AS clip_length,
       pc.position, pc.speed, pc.pitch, pc.color_tag, pc.comment
FROM playlist_clips pc
JOIN clips c ON c.id = pc.clip_id
JOIN songs s ON s.id = c.song_id
WHERE pc.playlist_id = :playlistId
  AND (
    s.title ILIKE '%' || :query || '%'
    OR s.title_pinyin ILIKE '%' || :query || '%'
    OR s.title_pinyin_initials LIKE :query || '%'
  )
ORDER BY pc.position;
```

---

## Clipping Workflow

Users clip songs through the UI. The backend finds or creates clip records:

```javascript
// User selects a song and chooses a start time
// POST /api/clips { songId, start, length }

// Backend validates:
// 1. Song exists
// 2. start >= 0 && start < song.duration
// 3. length is always 20

// Step 1: Check if clip already exists
const song = await prisma.song.findUnique({ where: { id: songId } });
let clip = await prisma.clip.findUnique({
  where: { songId_start: { songId, start } },
});

// Step 2: If not, create it with sliced lyrics
if (!clip) {
  const clipLyrics = sliceLRC(song.lyrics, start, start + length);

  clip = await prisma.clip.create({
    data: {
      songId: songId,
      start: start, // e.g., 45 (seconds)
      length: length, // 20
      lyrics: clipLyrics, // LRC lines within this clip's time range
    },
  });

  // Update the song's starts column (append new start time)
  const newStarts = song.starts ? `${song.starts}|${start}` : `${start}`;
  const sorted = newStarts
    .split("|")
    .map(Number)
    .sort((a, b) => a - b)
    .join("|");
  await prisma.song.update({
    where: { id: songId },
    data: { starts: sorted },
  });
}

// Now the clip can be added to playlists
// POST /api/playlists/:id/clips { clipId }
```

**LRC slicing helper** — extracts lyric lines that fall within a clip's time range:

```javascript
// LRC format: "[mm:ss.xx]lyric text" per line
// Example: "[01:23.45]月亮代表我的心"

function sliceLRC(lrcString, startSec, endSec) {
  if (!lrcString) return null;

  const lines = lrcString.split("\n");
  const result = [];

  for (const line of lines) {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
    if (!match) continue;

    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const timeSec = minutes * 60 + seconds;

    if (timeSec >= startSec && timeSec < endSec) {
      result.push(line);
    }
  }

  return result.length > 0 ? result.join("\n") : null;
}
```

**Auto-clipping helper** (optional — generate all clips for a song at once):

```javascript
// Given a song of 240 seconds with clip length 20:
// Creates clips at: 0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220
// The last clip (220) plays from 220 to 240 (20 seconds)

async function autoClipSong(songId, clipLength = 20) {
  const song = await prisma.song.findUnique({ where: { id: songId } });
  const starts = [];
  for (let t = 0; t < song.duration; t += clipLength) {
    starts.push(t);
  }
  // createMany doesn't support per-row computed fields, so use a loop
  for (const start of starts) {
    const clipLyrics = sliceLRC(song.lyrics, start, start + clipLength);
    await prisma.clip.upsert({
      where: { songId_start: { songId, start } },
      create: { songId, start, length: clipLength, lyrics: clipLyrics },
      update: {}, // Skip if already exists
    });
  }

  // Update the song's starts column with all clip start times
  // Merge with any existing starts (in case some clips already existed)
  const existing = song.starts ? song.starts.split("|").map(Number) : [];
  const merged = [...new Set([...existing, ...starts])]
    .sort((a, b) => a - b)
    .join("|");
  await prisma.song.update({
    where: { id: songId },
    data: { starts: merged },
  });
}
```

---

## Pinyin Generation (at import time)

Use the `pinyin` npm package in the import script:

```javascript
const pinyin = require("pinyin");

function toPinyin(chinese) {
  // Returns full pinyin with spaces: "yue liang dai biao wo de xin"
  return pinyin(chinese, { style: pinyin.STYLE_NORMAL })
    .map((p) => p[0])
    .join(" ");
}

function toPinyinInitials(chinese) {
  // Returns first letter of each character: "yldbwdx"
  return pinyin(chinese, { style: pinyin.STYLE_FIRST_LETTER })
    .map((p) => p[0])
    .join("");
}

// For a song with artist = "周杰伦_费玉清"
const artists = artist.split("_");
// Insert into song_artists for each:
// { artist_name: "周杰伦", artist_pinyin: "zhou jie lun", artist_pinyin_initials: "zjl" }
// { artist_name: "费玉清", artist_pinyin: "fei yu qing", artist_pinyin_initials: "fyq" }
```

---

## Performance Notes

| Concern                     | Solution                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| 200k rows + fuzzy search    | `pg_trgm` GIN indexes — trigram matching is fast even on large tables                          |
| Pinyin initial search       | B-tree index on `_pinyin_initials` column — prefix `LIKE 'abc%'` uses index                    |
| Multi-artist search         | `song_artists` junction table with its own trigram indexes — avoids scanning all 200k songs    |
| Playlist search scope       | Partial index on `is_public = true` + index on `user_id` — two fast lookups combined with `OR` |
| Search response time target | All queries return in <50ms with proper indexes on 200k rows                                   |
| Storage overhead            | ~4 extra TEXT columns per song (~100-200 bytes) + song_artists rows — minimal                  |
| Clips table size            | Grows as users clip songs — with index on `song_id`, lookups stay fast                         |

---

## Prisma Schema

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  PENDING
  MEMBER
  ADMIN
}

model User {
  id           String     @id @default(uuid()) @db.Uuid
  username     String     @unique
  passwordHash String     @map("password_hash")
  role         Role       @default(PENDING)
  createdAt    DateTime   @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime   @updatedAt @map("updated_at") @db.Timestamptz

  playlists        Playlist[]
  likes            Like[]
  sharedPlaylists  PlaylistShare[]
  copyPermissions  PlaylistCopyPermission[]

  @@map("users")
}

model Song {
  id                   String   @id @default(uuid()) @db.Uuid
  title                String
  artist               String
  duration             Int?
  filePath             String   @map("file_path")
  lyrics               String?
  starts               String?                      // Pipe-delimited clip start times, e.g. "0|25|50|75"

  titlePinyin          String?  @map("title_pinyin")
  titlePinyinInitials  String?  @map("title_pinyin_initials")
  artistPinyin         String?  @map("artist_pinyin")
  artistPinyinInitials String?  @map("artist_pinyin_initials")

  createdAt            DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt            DateTime @updatedAt @map("updated_at") @db.Timestamptz

  songArtists          SongArtist[]
  clips                Clip[]

  @@map("songs")
}

model SongArtist {
  id                   String @id @default(uuid()) @db.Uuid
  songId               String @map("song_id") @db.Uuid
  artistName           String @map("artist_name")
  artistPinyin         String? @map("artist_pinyin")
  artistPinyinInitials String? @map("artist_pinyin_initials")
  position             Int    @default(0)

  song                 Song   @relation(fields: [songId], references: [id], onDelete: Cascade)

  @@map("song_artists")
}

model Clip {
  id        String   @id @default(uuid()) @db.Uuid
  songId    String   @map("song_id") @db.Uuid
  start     Int                                   // Start time in seconds
  length    Int      @default(20)                 // 20 seconds
  lyrics    String?                               // LRC lyrics sliced from song for this clip's time range

  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz

  song          Song           @relation(fields: [songId], references: [id], onDelete: Cascade)
  playlistClips PlaylistClip[]
  likes         Like[]

  @@unique([songId, start])
  @@map("clips")
}

model Playlist {
  id                  String   @id @default(uuid()) @db.Uuid
  userId              String   @map("user_id") @db.Uuid
  name                String
  description         String?
  isPublic            Boolean  @default(false) @map("is_public")

  namePinyin          String?  @map("name_pinyin")
  namePinyinInitials  String?  @map("name_pinyin_initials")

  createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt           DateTime @updatedAt @map("updated_at") @db.Timestamptz

  user                User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  playlistClips       PlaylistClip[]
  likes               Like[]
  shares              PlaylistShare[]
  copyPermissions     PlaylistCopyPermission[]

  @@map("playlists")
}

model PlaylistShare {
  id         String   @id @default(uuid()) @db.Uuid
  playlistId String   @map("playlist_id") @db.Uuid
  userId     String   @map("user_id") @db.Uuid

  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz

  playlist   Playlist @relation(fields: [playlistId], references: [id], onDelete: Cascade)
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([playlistId, userId])
  @@map("playlist_shares")
}

model PlaylistCopyPermission {
  id         String   @id @default(uuid()) @db.Uuid
  playlistId String   @map("playlist_id") @db.Uuid
  userId     String   @map("user_id") @db.Uuid

  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz

  playlist   Playlist @relation(fields: [playlistId], references: [id], onDelete: Cascade)
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([playlistId, userId])
  @@map("playlist_copy_permissions")
}

model PlaylistClip {
  id         String   @id @default(uuid()) @db.Uuid
  playlistId String   @map("playlist_id") @db.Uuid
  clipId     String   @map("clip_id") @db.Uuid
  position   Int

  speed      Float    @default(1.0)              // Playback speed (0.5–2.0)
  pitch      Int      @default(0)                // Semitone shift (-12 to +12)
  colorTag   String?  @map("color_tag")          // Hex color, e.g. "#FF5733"
  comment    String?                             // User's note on this clip

  addedAt    DateTime @default(now()) @map("added_at") @db.Timestamptz

  playlist   Playlist @relation(fields: [playlistId], references: [id], onDelete: Cascade)
  clip       Clip     @relation(fields: [clipId], references: [id], onDelete: Cascade)

  @@unique([playlistId, clipId])
  @@map("playlist_clips")
}

model Like {
  id         String   @id @default(uuid()) @db.Uuid
  userId     String   @map("user_id") @db.Uuid
  playlistId String   @map("playlist_id") @db.Uuid
  clipId     String   @map("clip_id") @db.Uuid
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz

  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  playlist   Playlist @relation(fields: [playlistId], references: [id], onDelete: Cascade)
  clip       Clip     @relation(fields: [clipId], references: [id], onDelete: Cascade)

  @@unique([userId, playlistId, clipId])
  @@map("likes")
}
```

**Note:** The trigram (GIN) indexes and partial indexes must be created via a raw SQL migration since Prisma doesn't support `USING GIN` or `pg_trgm` natively. Add a migration file:

```sql
-- migration: add_search_indexes.sql
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Song search
CREATE INDEX idx_songs_title_trgm ON songs USING GIN (title gin_trgm_ops);
CREATE INDEX idx_songs_title_pinyin_trgm ON songs USING GIN (title_pinyin gin_trgm_ops);
CREATE INDEX idx_songs_title_pinyin_initials ON songs(title_pinyin_initials);
CREATE INDEX idx_songs_artist_trgm ON songs USING GIN (artist gin_trgm_ops);

-- Song artists search
CREATE INDEX idx_song_artists_song_id ON song_artists(song_id);
CREATE INDEX idx_song_artists_name_trgm ON song_artists USING GIN (artist_name gin_trgm_ops);
CREATE INDEX idx_song_artists_pinyin_trgm ON song_artists USING GIN (artist_pinyin gin_trgm_ops);
CREATE INDEX idx_song_artists_initials ON song_artists(artist_pinyin_initials);

-- Clips
CREATE INDEX idx_clips_song_id ON clips(song_id);

-- Playlist search
CREATE INDEX idx_playlists_user_id ON playlists(user_id);
CREATE INDEX idx_playlists_public ON playlists(is_public) WHERE is_public = true;
CREATE INDEX idx_playlists_name_trgm ON playlists USING GIN (name gin_trgm_ops);
CREATE INDEX idx_playlists_name_pinyin_trgm ON playlists USING GIN (name_pinyin gin_trgm_ops);
CREATE INDEX idx_playlists_name_pinyin_initials ON playlists(name_pinyin_initials);

-- Playlist shares
CREATE INDEX idx_playlist_shares_playlist ON playlist_shares(playlist_id);
CREATE INDEX idx_playlist_shares_user ON playlist_shares(user_id);

-- Playlist copy permissions
CREATE INDEX idx_playlist_copy_perms_playlist ON playlist_copy_permissions(playlist_id);
CREATE INDEX idx_playlist_copy_perms_user ON playlist_copy_permissions(user_id);

-- Playlist clips
CREATE INDEX idx_playlist_clips_playlist ON playlist_clips(playlist_id, position);
CREATE INDEX idx_playlist_clips_clip ON playlist_clips(clip_id);
CREATE INDEX idx_playlist_clips_color ON playlist_clips(playlist_id, color_tag) WHERE color_tag IS NOT NULL;

-- Likes
CREATE INDEX idx_likes_user_playlist ON likes(user_id, playlist_id);
CREATE INDEX idx_likes_user_clips ON likes(user_id);
```
