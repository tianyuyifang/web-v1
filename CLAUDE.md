# CLAUDE.md

## Project

Music clip playlist web app — Next.js frontend, Express.js backend, PostgreSQL database. Users browse ~400 songs (expandable), create clips (20/25s segments), organize into playlists, and like clips. Access is invite-only: new accounts start as PENDING and must be approved by an admin.

## Key Design Documents

- **DATABASE.md** — PostgreSQL schema design: tables, pinyin search (fuzzy/full/initials via `pg_trgm`), clips as playable units, playlists, likes, UTF-8/Chinese support.
- **FRONTEND.md** — Next.js App Router frontend design: Tailwind CSS dark theme, Zustand state, audio playback with pitch shifting, virtual scrolling, drag-and-drop playlist reordering, LRC lyrics.

## Tech Stack

- **Frontend:** Next.js 14.2 (App Router), React 18, Tailwind CSS 3.4, Zustand 4.5, Axios
- **Backend:** Express.js (JavaScript)
- **Database:** PostgreSQL with Prisma ORM (9 tables, 4 migrations)
- **Auth:** JWT (7-day expiry), bcrypt, localStorage + cookie sync; roles: PENDING / MEMBER / ADMIN
- **Audio:** HTML5 `<audio>` + Web Audio API, soundtouchjs (pitch shifting)
- **UI:** @tanstack/react-virtual (virtualized lists), @dnd-kit (drag-and-drop)

## Running the App

- **Backend:** `cd backend && npm run dev` → http://localhost:4000
- **Frontend:** `cd frontend && npm run dev` → http://localhost:3000
- **Import songs:** `cd backend && npm run import` (scans `music/` folder)
- **Seed admins:** `cd backend && node scripts/seed-admins.js` (reads ADMIN_1/2 from .env)
- **DB summary:** `cd backend && node tests/db-summary.js`
- **E2E test:** `cd backend && node tests/e2e-test.js`

## Progress

### Completed

#### Backend — Core

- Project scaffolding, environment config (`.env`, `src/config/index.js`)
- Database: `music_app` DB, Prisma schema, 4 migrations
- 9 tables: users, songs, song_artists, clips, playlists, playlist_clips, playlist_shares, playlist_copy_permissions, likes
- Prisma client singleton (`src/db/client.js`)
- Utility modules: `errors.js`, `pinyin.js`, `lrc.js`, `email.js`
- Middleware: `auth.js` (JWT + requireRole + requireApproved), `errorHandler.js`, `validate.js` (Zod), `playlistAccess.js`
- Zod validators: `validators/auth.js` (register, login), `validators/clips.js`, `validators/playlists.js`, `validators/common.js`
- Import script: `scripts/import-songs.js` (MP3 scan, ID3 tags, filename fallback, LRC lyrics, pinyin, batch insert)
- Seed script: `scripts/seed-admins.js` (upserts 2 admin accounts from .env)

#### Backend — Services & Routes

- `services/authService.js` — register (username+password → PENDING), login (by username), getMe; role in JWT
- `services/adminService.js` — listUsers, listPending, approveUser, demoteUser, deleteUser
- `services/streamService.js` — MP3 file path resolution, HTTP Range header parsing
- `services/searchService.js` — query type detection (pinyin initials/full pinyin/Chinese), raw SQL for pg_trgm
- `services/songService.js` — song listing with cursor pagination
- `services/clipService.js` — create clip, auto-clip, LRC slicing
- `services/playlistService.js` — CRUD, clip management, reorder, copy
- `services/shareService.js` — playlist share access + copy permissions
- `services/likeService.js` — toggle like, get user likes
- `routes/auth.js` — register, login, me
- `routes/admin.js` — list/approve/demote/delete users (ADMIN only)
- `routes/stream.js` — byte-range MP3 streaming (206 partial content)
- `routes/songs.js` — search/browse with cursor pagination
- `routes/clips.js` — create, auto-clip
- `routes/playlists.js` — full CRUD + clip mgmt + shares + copy permissions + copy
- `routes/likes.js` — toggle, list (compound keys: "playlistId:clipId")
- `routes/users.js` — search by username (for share modal)

#### Frontend — Fully Connected to Backend

- **Auth flow:** register (username + password only) → PENDING; login by username; logout
- **Token management:** localStorage + cookie sync; post-login uses `window.location.href` so middleware sees cookie
- **Auth state:** Zustand `authStore` (shared across all components, single `me()` call on boot via Navbar)
- **API client** (`lib/api.js`): Axios with JWT interceptors, 401 redirect (skips auth routes)
- **Playlists** (`/playlists`): combined page — search all playlists + "+ New Playlist" button
- **Dashboard** (`/dashboard`): redirects to `/playlists`
- **New Playlist** (`/playlists/new`): tabbed — Create form + Import JSON tab
- **Library** (`/library`): song search with cursor pagination, virtual scrolling, clip creation
- **Playlist detail** (`/playlists/[id]`): player, clips sidebar, drag-and-drop reorder, sharing
- **Admin** (`/admin`): user management — approve/revoke/delete (ADMIN role only; Admin link in navbar)
- **Pending** (`/pending`): shown to PENDING users after login
- **Components:** PlayerBox, ProgressBar, VolumeControl, SpeedControl, PitchControl, LyricsBox, LikeButton, ColorTag, ClipComment, PlaylistGrid, PlaylistCard, PlaylistHeader, ClipSidebar, AddClipModal, SharePlaylistModal, ImportPlaylistModal, UserTable, SearchBar, SongTable, ClipCreator
- **State:** `authStore` (user, login, logout, init), `playerStore` (active player, likes cache)
- **Hooks:** `useAuth` (thin wrapper over authStore), `useAudioPlayer`, `useLikes`, `useSearch`
- **Theme:** Dark theme (background `#2a2a34`, surface `#353542`)

#### Frontend-Backend Integration Notes

- Error message: `err.response.data.error.message` (matches backend `{ error: { message } }` format)
- Login uses `window.location.href` (not `router.push`) so Next.js middleware sees the cookie on redirect
- Auth state is a Zustand store — `init()` called once in Navbar on mount; all components share state
- Playlist list response: `res.data.playlists`; songs list: `res.data.songs` with `nextCursor`
- Cookie key: `music_app_token` (7-day expiry, SameSite=Lax)

### Scripts

| Script                         | Command                       | Purpose                                                |
| ------------------------------ | ----------------------------- | ------------------------------------------------------ |
| `scripts/import-songs.js`      | `npm run import`              | Import MP3s + LRC from `music/` into DB                |
| `scripts/seed-admins.js`       | `node scripts/seed-admins.js` | Create/upsert admin accounts from ADMIN_1/2 env vars   |
| `tests/e2e-test.js`            | `node tests/e2e-test.js`      | API-level E2E smoke test (needs updating for new auth) |
| `tests/db-summary.js`          | `node tests/db-summary.js`    | Print counts and samples for all tables                |
| `tests/test-import-to-xlsx.js` | —                             | Temporary dry-run import preview (delete after use)    |

### Next Steps

1. **Audio playback testing** — Verify pitch shifting, speed control, clip boundaries, and lyrics sync in browser
2. **Error handling** — React error boundaries, toast notifications for API errors
3. **Mobile responsiveness** — Test and fix layout on mobile screens
4. **Security hardening** — Rate limiting on auth endpoints, CORS tightening for production
5. **Deployment** — Production build, nginx reverse proxy, SSL

## Notes

- `pinyin` v3 exports `{ pinyin, compare, ... }` not a callable — use `require('pinyin').pinyin`
- MP3 lyrics: matching `.lrc` file with same basename loaded at import time
- Artist separator in filenames/DB: underscore `_` (e.g. "周杰伦\_费玉清")
- PostgreSQL password contains `@` — must be URL-encoded as `%40` in DATABASE_URL
- Windows terminal garbles Chinese in curl output — use Node `http` module for testing Chinese endpoints
- `music/` folder at project root for local MP3 storage (in `.gitignore`), `MP3_BASE_PATH=C:/Projects/web-v1/music`
- Backend error format: `{ error: { message, status, details } }` — frontend must read `.error.message`
- `frontend/src/lib/mock-data.js` is not imported anywhere — safe to delete
- Prisma generate fails if backend is running (DLL lock on Windows) — stop backend first (`taskkill //F //IM node.exe`)
- User roles: `PENDING` (default), `MEMBER` (approved), `ADMIN` (seeded via script)
- PENDING users: login succeeds, redirects to `/pending`; all protected API routes return 403
- Admin accounts: seeded via `node scripts/seed-admins.js` — reads `ADMIN_1/2_USERNAME/PASSWORD` from `.env`
- No email field on users; no password reset flow
- `e2e-test.js` needs updating: remove email from register payload, use username for login, approve user before testing protected routes
