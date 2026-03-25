# Backend Design

## Overview

Express.js REST API server (JavaScript) serving the Next.js frontend. Handles authentication, song/clip/playlist CRUD, pinyin-based search across 200k songs, audio streaming with byte-range support, and playlist sharing/copying. Uses Prisma ORM with PostgreSQL.

---

## Tech Stack

| Layer          | Technology                                      |
| -------------- | ----------------------------------------------- |
| Framework      | Express.js                                      |
| Language       | JavaScript (Node.js)                            |
| Database       | PostgreSQL with `pg_trgm` extension             |
| ORM            | Prisma                                          |
| Authentication | JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`)       |
| Validation     | Zod                                             |
| Audio          | Node.js `fs` streams with byte-range support    |
| Pinyin         | `pinyin` npm package (at import time)            |
| Metadata       | `music-metadata` (MP3 tag extraction at import)  |

---

## Project Structure

```
backend/
├── prisma/
│   ├── schema.prisma              # Prisma schema (see DATABASE.md)
│   └── migrations/                # Prisma migration files
│       └── add_search_indexes.sql # Raw SQL: pg_trgm GIN indexes
│
├── src/
│   ├── server.js                  # Express app entry point
│   │
│   ├── config/
│   │   └── index.js               # Environment config (PORT, JWT_SECRET, DB, MP3_BASE_PATH)
│   │
│   ├── db/
│   │   └── client.js              # Prisma client singleton
│   │
│   ├── middleware/
│   │   ├── auth.js                # JWT verification → req.user
│   │   ├── errorHandler.js        # Global error handler
│   │   ├── validate.js            # Zod schema validation middleware
│   │   └── playlistAccess.js      # Playlist ownership/share/public access checks
│   │
│   ├── routes/
│   │   ├── auth.js                # POST /register, /login, /me
│   │   ├── songs.js               # GET /songs, GET /songs/:id
│   │   ├── clips.js               # POST /clips, POST /clips/auto
│   │   ├── playlists.js           # CRUD /playlists, nested clip/share/copy routes
│   │   ├── likes.js               # POST /likes/toggle, GET /likes
│   │   ├── stream.js              # GET /stream/:songId (byte-range MP3)
│   │   └── users.js               # GET /users/search (for share modal)
│   │
│   ├── services/
│   │   ├── authService.js         # Password hashing, JWT sign/verify
│   │   ├── songService.js         # Song queries, pinyin search, pagination
│   │   ├── clipService.js         # Clip creation, auto-clipping, LRC slicing
│   │   ├── playlistService.js     # Playlist CRUD, clip management, reorder
│   │   ├── shareService.js        # Playlist sharing & copy permissions
│   │   ├── likeService.js         # Like toggle & queries
│   │   ├── streamService.js       # File path resolution, range header parsing
│   │   └── searchService.js       # Query type detection, unified search logic
│   │
│   ├── validators/
│   │   ├── auth.js                # Register/login schemas
│   │   ├── clips.js               # Clip creation schemas
│   │   ├── playlists.js           # Playlist CRUD schemas
│   │   └── common.js              # Shared schemas (UUID, pagination)
│   │
│   └── utils/
│       ├── pinyin.js              # toPinyin(), toPinyinInitials() helpers
│       ├── lrc.js                 # sliceLRC() — extract lyrics for clip time range
│       └── errors.js              # Custom error classes (AppError, NotFoundError, etc.)
│
├── scripts/
│   ├── import-songs.js            # Scan MP3 folder → populate songs + song_artists
│   └── seed.js                    # Dev seed data (test users, playlists)
│
├── .env                           # DATABASE_URL, JWT_SECRET, MP3_BASE_PATH, PORT
├── .env.example
└── package.json
```

---

## Configuration

### Environment Variables

```env
PORT=4000
DATABASE_URL=postgresql://user:password@localhost:5432/music_app
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=7d
MP3_BASE_PATH=/path/to/mp3/files
FRONTEND_URL=http://localhost:3000
```

### `src/config/index.js`

```js
module.exports = {
  port: process.env.PORT || 4000,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  mp3BasePath: process.env.MP3_BASE_PATH,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
};
```

---

## Entry Point

### `src/server.js`

```js
const express = require('express');
const cors = require('cors');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const authMiddleware = require('./middleware/auth');

const app = express();

// Global middleware
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json());

// Public routes
app.use('/api/auth', require('./routes/auth'));

// Protected routes
app.use('/api/songs', authMiddleware, require('./routes/songs'));
app.use('/api/clips', authMiddleware, require('./routes/clips'));
app.use('/api/playlists', authMiddleware, require('./routes/playlists'));
app.use('/api/likes', authMiddleware, require('./routes/likes'));
app.use('/api/stream', authMiddleware, require('./routes/stream'));
app.use('/api/users', authMiddleware, require('./routes/users'));

// Error handling
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});
```

---

## Middleware

### Auth (`middleware/auth.js`)

- Extracts JWT from `Authorization: Bearer <token>` header
- Verifies with `jsonwebtoken`, attaches `req.user = { id, email, username }`
- Returns 401 if token missing/invalid/expired

### Validation (`middleware/validate.js`)

```js
// Usage: router.post('/', validate(createPlaylistSchema), handler)
const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ errors: result.error.flatten().fieldErrors });
  }
  req.validated = result.data;
  next();
};
```

### Playlist Access (`middleware/playlistAccess.js`)

Reusable middleware that loads a playlist and checks access rights. Attaches `req.playlist` and `req.playlistAccess` with flags:

```js
req.playlistAccess = {
  isOwner: true/false,
  isShared: true/false,
  canView: true/false,     // owner OR shared OR public
  canEdit: true/false,     // owner only
  canCopy: true/false,     // has row in playlist_copy_permissions + canView
};
```

### Error Handler (`middleware/errorHandler.js`)

```js
// Catches all errors, returns consistent JSON
// { error: { message, status, details? } }
// Logs stack trace in development, hides in production
```

---

## API Routes

### Authentication — `/api/auth`

| Method | Path        | Auth | Description                          |
| ------ | ----------- | ---- | ------------------------------------ |
| POST   | `/register` | No   | Create account (username, email, password) |
| POST   | `/login`    | No   | Login, returns JWT + user object     |
| POST   | `/me`       | Yes  | Validate session, return current user |

**Register validation:** username (3-30 chars, alphanumeric), email (valid format, unique), password (8+ chars).

**Login response:**
```json
{
  "token": "eyJhbG...",
  "user": { "id": "uuid", "username": "user1", "email": "user1@example.com" }
}
```

---

### Songs — `/api/songs`

| Method | Path       | Auth | Description                                   |
| ------ | ---------- | ---- | --------------------------------------------- |
| GET    | `/`        | Yes  | Search/browse songs with cursor pagination    |
| GET    | `/:id`     | Yes  | Song detail with all its clips                |

**GET `/api/songs`** query params:

| Param    | Type   | Description                                      |
| -------- | ------ | ------------------------------------------------ |
| `q`      | string | Search query (Chinese, full pinyin, or initials)  |
| `cursor` | string | Cursor for pagination (song ID)                   |
| `limit`  | number | Page size (default 50, max 100)                   |

**Search flow** (in `searchService.js`):
1. Detect query type: pinyin initials / full pinyin / Chinese characters
2. Search `songs` table + `song_artists` table using appropriate columns and indexes
3. Return songs with their clips (LEFT JOIN)

**Response:**
```json
{
  "songs": [
    {
      "id": "uuid",
      "title": "月亮代表我的心",
      "artist": "邓丽君",
      "duration": 240,
      "filePath": "月亮代表我的心 - 邓丽君.mp3",
      "starts": "0|25|50",
      "clips": [
        { "id": "uuid", "start": 0, "length": 25 },
        { "id": "uuid", "start": 25, "length": 25 }
      ]
    }
  ],
  "nextCursor": "uuid-of-last-song"
}
```

---

### Clips — `/api/clips`

| Method | Path    | Auth | Description                              |
| ------ | ------- | ---- | ---------------------------------------- |
| POST   | `/`     | Yes  | Create a clip from a song                |
| POST   | `/auto` | Yes  | Auto-clip entire song at intervals       |

**POST `/api/clips`** body:

```json
{ "songId": "uuid", "start": 45, "length": 25 }
```

**Validation:**
- Song must exist
- `start >= 0` and `start < song.duration`
- `length` is 20 or 25
- If clip already exists at this `(songId, start)`, return the existing clip

**Logic:**
1. Find or create clip with `UNIQUE(songId, start)`
2. Slice LRC lyrics from song for the clip's time range (`sliceLRC`)
3. Update `song.starts` column (append + sort)
4. Return the clip

**POST `/api/clips/auto`** body:

```json
{ "songId": "uuid", "length": 25 }
```

Creates clips at every `length`-second interval for the entire song duration.

---

### Playlists — `/api/playlists`

| Method | Path                               | Auth | Access   | Description                                |
| ------ | ---------------------------------- | ---- | -------- | ------------------------------------------ |
| GET    | `/`                                | Yes  | User     | List own + shared + public playlists       |
| POST   | `/`                                | Yes  | User     | Create playlist                            |
| GET    | `/:id`                             | Yes  | Viewer   | Playlist with clips and customization      |
| PUT    | `/:id`                             | Yes  | Owner    | Update playlist (name, description, etc.)  |
| DELETE | `/:id`                             | Yes  | Owner    | Delete playlist                            |
| POST   | `/:id/clips`                       | Yes  | Owner    | Add clip to playlist                       |
| DELETE | `/:id/clips`                       | Yes  | Owner    | Remove clip from playlist                  |
| PUT    | `/:id/clips/reorder`               | Yes  | Owner    | Update clip positions                      |
| PUT    | `/:id/clips/:clipId`               | Yes  | Owner    | Update clip customization                  |
| GET    | `/:id/shares`                      | Yes  | Owner    | List shared users                          |
| POST   | `/:id/shares`                      | Yes  | Owner    | Share with a user                          |
| DELETE | `/:id/shares/:userId`              | Yes  | Owner    | Remove a share                             |
| GET    | `/:id/copy-permissions`            | Yes  | Owner    | List users with copy permission            |
| POST   | `/:id/copy-permissions`            | Yes  | Owner    | Grant copy permission                      |
| DELETE | `/:id/copy-permissions/:userId`    | Yes  | Owner    | Revoke copy permission                     |
| POST   | `/:id/copy`                        | Yes  | CopyPerm | Copy playlist (requires copy + view)       |

#### GET `/api/playlists`

Query params: `q` (search), optional. Returns playlists sorted: own first, shared second, public last. Each playlist includes `isOwner`, `isShared`, `canCopy` flags.

#### GET `/api/playlists/:id`

Query params: `q` (filter clips by song title/artist). Returns full playlist with ordered clips, each including song metadata and customization fields.

**Response:**
```json
{
  "id": "uuid",
  "name": "我的歌单",
  "description": "...",
  "isPublic": false,
  "isOwner": true,
  "isShared": false,
  "canCopy": false,
  "clips": [
    {
      "id": "playlist-clip-uuid",
      "clipId": "clip-uuid",
      "position": 0,
      "speed": 1.0,
      "pitch": 0,
      "colorTag": "#FF5733",
      "comment": "好听的副歌",
      "clip": {
        "id": "clip-uuid",
        "start": 45,
        "length": 25,
        "lyrics": "[01:23.45]月亮代表...",
        "song": {
          "id": "song-uuid",
          "title": "月亮代表我的心",
          "artist": "邓丽君",
          "duration": 240,
          "filePath": "月亮代表我的心 - 邓丽君.mp3"
        }
      }
    }
  ]
}
```

#### POST `/:id/clips`

```json
{ "clipId": "uuid" }
```

Adds the clip at the end of the playlist (position = max + 1). Default customization: speed 1.0, pitch 0, no color/comment.

#### DELETE `/:id/clips`

```json
{ "clipId": "uuid" }
```

**Important:** Also deletes any likes for this clip in this playlist (manual cascade — see DATABASE.md).

#### PUT `/:id/clips/reorder`

```json
{ "clipIds": ["uuid1", "uuid2", "uuid3"] }
```

Receives the full ordered list of clip IDs. Updates `position` for each.

#### PUT `/:id/clips/:clipId`

```json
{ "speed": 1.1, "pitch": 2, "colorTag": "#FF5733", "comment": "好听" }
```

All fields optional — only updates provided fields.

#### POST `/:id/copy`

Creates a full copy of the playlist for the requesting user. Copies all clips with their customization. The copy is private and fully independent. Returns the new playlist.

---

### Likes — `/api/likes`

| Method | Path      | Auth | Description                                  |
| ------ | --------- | ---- | -------------------------------------------- |
| POST   | `/toggle` | Yes  | Toggle like on a clip within a playlist      |
| GET    | `/`       | Yes  | Get all user's liked clips (as compound keys)|

**POST `/api/likes/toggle`** body:

```json
{ "playlistId": "uuid", "clipId": "uuid" }
```

Checks if like exists → deletes it (unlike) or creates it (like). Returns `{ liked: true/false }`.

**GET `/api/likes`** response:

```json
{
  "likes": ["playlistId:clipId", "playlistId:clipId"]
}
```

Returns compound keys so the frontend can build a Set for quick lookups.

---

### Stream — `/api/stream`

| Method | Path         | Auth | Description                        |
| ------ | ------------ | ---- | ---------------------------------- |
| GET    | `/:songId`   | Yes  | Stream MP3 with byte-range support |

**Implementation:**
1. Look up `song.filePath` from DB
2. Resolve full path: `path.join(MP3_BASE_PATH, song.filePath)`
3. Parse `Range` header if present
4. Set response headers:
   - `Content-Type: audio/mpeg`
   - `Accept-Ranges: bytes`
   - `Content-Length` / `Content-Range` for range requests
5. Return 206 (partial) for range requests, 200 for full file
6. Pipe `fs.createReadStream` with `start`/`end` options

---

### Users — `/api/users`

| Method | Path      | Auth | Description                              |
| ------ | --------- | ---- | ---------------------------------------- |
| GET    | `/search` | Yes  | Search users by username/email (for sharing) |

Query params: `q` (search string). Returns minimal user info (id, username, email). Limited to 10 results.

---

## Services

### `authService.js`

```js
hashPassword(plain)              // bcrypt hash (10 rounds)
comparePassword(plain, hash)     // bcrypt compare
signToken(userId)                // JWT with { sub: userId }, 7d expiry
verifyToken(token)               // Decode and verify
```

### `songService.js`

```js
searchSongs(query, cursor, limit)    // Delegates to searchService for query detection
getSongById(songId)                   // Song with clips
```

### `clipService.js`

```js
createClip(songId, start, length)     // Find-or-create, slice LRC, update song.starts
autoClipSong(songId, length)          // Create clips at every interval
sliceLRC(lrcString, startSec, endSec) // Extract lyrics for time range
```

### `playlistService.js`

```js
getUserPlaylists(userId, query)                     // Own + shared + public, with search
getPlaylistById(playlistId, userId, clipQuery)       // Full playlist with access flags
createPlaylist(userId, data)                         // Create with pinyin generation
updatePlaylist(playlistId, data)                     // Update with pinyin regeneration if name changed
deletePlaylist(playlistId)                           // Delete (cascades)
addClipToPlaylist(playlistId, clipId)                // Add at end
removeClipFromPlaylist(playlistId, clipId, userId)   // Remove + clean up likes
reorderClips(playlistId, clipIds)                    // Bulk position update
updateClipCustomization(playlistId, clipId, data)    // Speed, pitch, color, comment
copyPlaylist(playlistId, userId)                     // Full copy for user
```

### `shareService.js`

```js
getShares(playlistId)                                // Users shared with
addShare(playlistId, userId)                         // Share with user
removeShare(playlistId, userId)                      // Revoke share
getCopyPermissions(playlistId)                       // Users with copy permission
addCopyPermission(playlistId, userId)                // Grant copy
removeCopyPermission(playlistId, userId)             // Revoke copy
```

### `searchService.js`

```js
detectQueryType(query)   // Returns 'pinyin_initials' | 'full_pinyin' | 'chinese'
searchSongs(query, cursor, limit)    // Multi-strategy search across songs + song_artists
searchPlaylists(query, userId)       // Search playlists with access filtering
searchClipsInPlaylist(playlistId, query)  // Filter clips by song title/artist
```

**Query type detection logic:**
```
ASCII lowercase, no spaces, short  → pinyin initials  (LIKE 'abc%')
ASCII with spaces                  → full pinyin       (ILIKE '%zhou jie%' + trigram)
Contains CJK characters            → Chinese fuzzy     (ILIKE '%月亮%' + trigram)
ASCII no spaces, long              → full pinyin       (trigram handles partial)
```

### `streamService.js`

```js
getSongFilePath(songId)              // DB lookup → resolve to absolute path
parseRangeHeader(rangeHeader, fileSize)  // Parse "bytes=start-end"
```

---

## Error Handling

### Custom Error Classes (`utils/errors.js`)

```js
class AppError extends Error {
  constructor(message, statusCode) { ... }
}

class NotFoundError extends AppError {       // 404
  constructor(resource) { super(`${resource} not found`, 404); }
}

class UnauthorizedError extends AppError {   // 401
  constructor() { super('Unauthorized', 401); }
}

class ForbiddenError extends AppError {      // 403
  constructor() { super('Forbidden', 403); }
}

class ValidationError extends AppError {     // 400
  constructor(details) { super('Validation failed', 400); this.details = details; }
}
```

### Error Handler Response Format

```json
{
  "error": {
    "message": "Playlist not found",
    "status": 404
  }
}
```

In development, includes `stack` trace. Prisma-specific errors (unique constraint, foreign key) are mapped to appropriate HTTP status codes.

---

## Song Import Script

### `scripts/import-songs.js`

Scans an MP3 directory and populates the database:

1. Recursively find all `.mp3` files
2. For each file:
   - Extract metadata (title, artist, duration) via `music-metadata`
   - If title/artist missing, derive from filename: `"Title - Artist.mp3"`
   - Generate pinyin columns: `toPinyin(title)`, `toPinyinInitials(title)`
   - Split artist by `_` for multi-artist songs
3. Batch insert into `songs` table (500 per batch via `createMany`)
4. For each song, insert rows into `song_artists` with individual artist pinyin
5. Log progress: `"Imported 5000/200000 songs..."`
6. Skip files that fail metadata extraction (log error, continue)

**Usage:**
```bash
node scripts/import-songs.js --dir /path/to/mp3s
```

---

## Authentication Flow

```
1. User registers  →  POST /api/auth/register
   - Validate input (Zod)
   - Check email/username uniqueness
   - Hash password (bcrypt, 10 rounds)
   - Create user in DB
   - Sign JWT (7-day expiry)
   - Return { token, user }

2. User logs in    →  POST /api/auth/login
   - Find user by email
   - Compare password
   - Sign JWT
   - Return { token, user }

3. Authenticated request → Any protected route
   - Frontend sends: Authorization: Bearer <token>
   - auth middleware verifies token
   - Attaches req.user = { id, email, username }
   - Route handler proceeds

4. Session check   →  POST /api/auth/me
   - Verify token
   - Return current user object
```

---

## Playlist Access Control

Access checks run via `playlistAccess` middleware on all `/:id` routes:

| Action                     | Who can do it                                  |
| -------------------------- | ---------------------------------------------- |
| View/play playlist         | Owner, shared users, anyone (if public)        |
| Edit playlist (name, etc.) | Owner only                                     |
| Add/remove/reorder clips   | Owner only                                     |
| Update clip customization  | Owner only                                     |
| Share/unshare              | Owner only                                     |
| Grant/revoke copy perms    | Owner only                                     |
| Copy playlist              | Users with copy permission + view access       |
| Delete playlist            | Owner only                                     |
| Like a clip in playlist    | Anyone with view access                        |

---

## Pagination

### Songs — Cursor-based

Essential for 200k rows. Uses the song `id` as cursor:

```sql
SELECT * FROM songs
WHERE id > :cursor
ORDER BY id
LIMIT :limit + 1;   -- Fetch one extra to detect hasMore
```

When combined with search, the cursor is applied after the search filter. Response includes `nextCursor` (the last song's ID) or `null` if no more results.

### Playlists — Offset-based

Users won't have thousands of playlists, so offset pagination is fine:

```sql
SELECT * FROM playlists
WHERE user_id = :userId OR is_public = true
LIMIT :limit OFFSET :offset;
```

---

## CORS Configuration

```js
app.use(cors({
  origin: config.frontendUrl,    // http://localhost:3000
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
```

In production, `FRONTEND_URL` should be set to the deployed frontend domain.

---

## Dependencies

```json
{
  "dependencies": {
    "express": "^4.18",
    "cors": "^2.8",
    "dotenv": "^16.3",
    "bcryptjs": "^2.4",
    "jsonwebtoken": "^9.0",
    "@prisma/client": "^5.0",
    "zod": "^3.22",
    "pinyin": "^3.0",
    "music-metadata": "^7.0"
  },
  "devDependencies": {
    "prisma": "^5.0",
    "nodemon": "^3.0"
  },
  "scripts": {
    "dev": "nodemon src/server.js",
    "start": "node src/server.js",
    "import": "node scripts/import-songs.js",
    "seed": "node scripts/seed.js",
    "db:migrate": "npx prisma migrate dev",
    "db:push": "npx prisma db push",
    "db:studio": "npx prisma studio"
  }
}
```

---

## Performance Considerations

| Concern                  | Solution                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| 200k song search         | `pg_trgm` GIN indexes + pre-computed pinyin columns (see DATABASE.md)    |
| Song list pagination     | Cursor-based pagination (fast on large tables)                           |
| Audio streaming          | Byte-range support (206 Partial Content) for seeking                     |
| Concurrent audio streams | Node.js streams — low memory, no full file buffering                     |
| Playlist clip queries    | Indexed JOINs: `playlist_clips` → `clips` → `songs`                     |
| Clip removal cleanup     | Manual like deletion before removing clip from playlist                  |
| Import speed             | Batch inserts (500/batch via `createMany`)                               |
| Pinyin computation       | Done once at import time, stored in columns — not at query time          |
