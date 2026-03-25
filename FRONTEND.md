# Frontend Design

## Overview

Next.js (App Router) frontend for a music clip playlist app. Users browse ~400 songs, create clips (20/25-second segments), organize clips into playlists with per-clip customization (speed, pitch, color tags, comments), and like clips. Access is invite-only — new accounts are PENDING until an admin approves them.

---

## Tech Stack

| Layer            | Technology                                        |
| ---------------- | ------------------------------------------------- |
| Framework        | Next.js 14.2 (App Router), React 18              |
| Styling          | Tailwind CSS 3.4, dark theme by default           |
| State Management | Zustand 4.5 (auth store + player store)           |
| HTTP Client      | Axios 1.x (with interceptors for auth)            |
| Audio            | HTML5 `<audio>` + Web Audio API (pitch shifting)  |
| Virtual Scroll   | `@tanstack/react-virtual`                         |
| Drag & Drop      | `@dnd-kit/core` (playlist reordering)             |
| Lyrics           | LRC format parser with time-synced display        |

---

## Data Model (Frontend Perspective)

### User

```js
{
  id: "uuid",
  username: "xiaofang",
  role: "MEMBER"   // "PENDING" | "MEMBER" | "ADMIN"
}
```

### Song

```js
{
  id: "uuid",
  title: "月亮代表我的心",
  artist: "邓丽君",             // Combined string, "_" separated for multi-artist
  duration: 240,                // Seconds
  filePath: "月亮代表我的心 - 邓丽君.mp3",
  lyrics: "[00:12.00]月亮代表我的心...",  // LRC format, nullable
  starts: "0|25|50|75",         // Pipe-delimited clip start times, nullable
  clips: [
    { id: "uuid", start: 0, length: 25 },
    { id: "uuid", start: 25, length: 25 }
  ]
}
```

### Clip

```js
{
  id: "uuid",
  songId: "uuid",
  start: 45,
  length: 25,
  lyrics: "[01:23.45]月亮代表...",  // LRC for this clip's range, nullable
  song: { id, title, artist, duration, filePath }
}
```

### Playlist

```js
{
  id: "uuid",
  name: "我的歌单",
  description: "...",
  isPublic: false,
  isOwner: true,
  isShared: false,
  canCopy: false,
  clips: [
    {
      id: "uuid",       // PlaylistClip ID
      clipId: "uuid",
      position: 0,
      speed: 1.0,
      pitch: 0,
      colorTag: "#FF5733",
      comment: "好听的副歌",
      clip: { id, start, length, song: { ... } }
    }
  ]
}
```

---

## Project Structure

```
frontend/src/
├── app/
│   ├── layout.js
│   ├── page.js                        # Redirects → /playlists or /login
│   ├── globals.css
│   ├── (auth)/
│   │   ├── login/page.js
│   │   ├── register/page.js
│   │   └── pending/page.js            # Shown after login when role = PENDING
│   ├── admin/
│   │   └── page.js                    # User management (ADMIN only)
│   ├── dashboard/
│   │   └── page.js                    # Redirects → /playlists
│   ├── playlists/
│   │   ├── page.js                    # All playlists + search + New Playlist button
│   │   ├── new/page.js                # Tabbed: Create form | Import JSON
│   │   └── [id]/
│   │       └── page.js                # Single playlist — player grid + clip sidebar
│   └── library/
│       └── page.js                    # Browse songs, create clips
├── components/
│   ├── admin/
│   │   └── UserTable.js               # Approve/revoke/delete users
│   ├── auth/
│   │   ├── LoginForm.js               # Username + password; window.location.href on success
│   │   └── RegisterForm.js            # Username + password; shows pending message on success
│   ├── layout/
│   │   └── Navbar.js                  # Calls authStore.init() on mount; shows Admin link for admins
│   ├── library/
│   │   ├── SongTable.js               # Virtualized song list
│   │   ├── SearchBar.js               # Pinyin/Chinese/fuzzy input
│   │   └── ClipCreator.js             # Create clips from a song
│   ├── player/
│   │   ├── PlayerBox.js               # Single clip player card
│   │   ├── ProgressBar.js
│   │   ├── VolumeControl.js
│   │   ├── SpeedControl.js
│   │   ├── PitchControl.js
│   │   ├── LyricsBox.js
│   │   ├── LikeButton.js
│   │   ├── ColorTag.js
│   │   └── ClipComment.js
│   └── playlist/
│       ├── PlaylistGrid.js            # Grid of PlayerBox cards
│       ├── PlaylistCard.js            # Playlist summary card
│       ├── PlaylistHeader.js          # Name, description, controls
│       ├── ClipSidebar.js             # Narrow clip list panel
│       ├── AddClipModal.js            # Search songs → add clip to playlist
│       ├── SharePlaylistModal.js      # Manage shares + copy permissions
│       └── ImportPlaylistModal.js     # (legacy modal, superseded by /playlists/new Import tab)
├── hooks/
│   ├── useAuth.js                     # Thin wrapper over authStore
│   ├── useAudioPlayer.js
│   ├── useLikes.js
│   └── useSearch.js
├── lib/
│   ├── api.js                         # Axios instance + interceptors + all API methods
│   ├── auth.js                        # getToken / setToken / clearToken (localStorage + cookie)
│   ├── lrc.js                         # LRC parser
│   └── utils.js
├── middleware.js                      # Route protection (cookie-based, server-side)
└── store/
    ├── authStore.js                   # Zustand: user, login, logout, init
    └── playerStore.js                 # Zustand: activePlayerId, likedClips
```

---

## Pages

### `/` (Landing)
- Redirects authenticated users to `/playlists`, unauthenticated to `/login`

### `/login`
- Username + password form
- On success: sets token via `setToken()`, then `window.location.href = "/playlists"` (full navigation so Next.js middleware sees cookie)
- If user role is PENDING: redirects to `/pending` instead

### `/register`
- Username + password + confirm password
- On success: shows "Account created — awaiting admin approval" message; no token issued
- No redirect to dashboard — user must wait for approval

### `/pending`
- Static message: account awaiting admin approval
- Public route (no token required)

### `/playlists`
- Combined playlist hub: search bar + playlist grid + "+ New Playlist" button
- Shows all playlists the user can see (own + shared + public), searchable by name/pinyin
- Fetches `GET /api/playlists?q=...`

### `/playlists/new`
- Two tabs:
  - **Create** — name, description, public toggle → `POST /api/playlists` → redirects to new playlist
  - **Import** — JSON file picker → `POST /api/playlists/import` → redirects to imported playlist

### `/playlists/[id]`
- Two-panel layout: clip sidebar (left) + PlayerBox grid (right)
- Playlist header: name, description, column selector, share button, edit mode toggle (owner only)
- Edit mode: drag-and-drop reorder, add/remove clips, per-clip customization controls
- Read-only view for shared/public users (play, view, like, copy if permitted)
- Fetches `GET /api/playlists/:id`

### `/library`
- Virtualized song list with pinyin/Chinese search
- Create clips from any song; add clips to playlists
- Cursor-based pagination via `GET /api/songs`

### `/admin`
- ADMIN role only (redirects others to `/playlists`)
- Lists users by section: Pending / Members / Admins
- Actions per user: Approve (PENDING→MEMBER), Revoke (MEMBER→PENDING), Delete
- Calls `GET /api/admin/users`, `PATCH /api/admin/users/:id/approve|demote`, `DELETE /api/admin/users/:id`

---

## Auth State (Zustand authStore)

```js
// store/authStore.js
{
  user: null,        // { id, username, role } or null
  loading: true,

  init()   // Called once by Navbar on mount — validates token via /auth/me
  login(username, password)  // Calls /auth/login, sets token + user
  logout()           // Clears token, sets user to null
}
```

```js
// hooks/useAuth.js — thin wrapper
const { user, isAuthenticated, isPending, isMember, isAdmin, loading, login, logout } = useAuth();
```

**Key behaviours:**
- `init()` runs once in Navbar's `useEffect` — all components share the same store state
- `login()` calls `window.location.href` (not `router.push`) after success so the cookie is visible to Next.js middleware during the redirect
- PENDING users can log in but are redirected to `/pending` and get 403 on all protected API routes

---

## Route Protection

```js
// middleware.js
// Public paths: /login, /register, /pending
// Protected matcher: /dashboard, /playlists/:path*, /library/:path*, /admin/:path*
// Checks for music_app_token cookie (set by setToken on login)
// Redirects to /login if no token found
```

---

## API Client (`lib/api.js`)

```js
// All API namespaces:
authAPI   — register, login, me
songsAPI  — search, getById
clipsAPI  — create, autoClip
playlistsAPI — list, create, getById, update, delete, importPlaylist, copy,
               addClip, removeClip, reorderClips, updateClip,
               getShares, addShare, removeShare,
               getCopyPermissions, addCopyPermission, removeCopyPermission
likesAPI  — toggle, getAll
adminAPI  — listUsers, listPending, approveUser, demoteUser, deleteUser
getStreamUrl(songId) — returns direct stream URL
```

**Interceptors:**
- Request: attaches `Authorization: Bearer <token>` from localStorage
- Response: on 401 (non-auth route) → clears token + `window.location.href = "/login"`

---

## Audio Playback

Each PlayerBox plays a clip: `start` → `start + length` seconds of the song.

```js
// On play:
audio.currentTime = clip.start;
audio.playbackRate = playlistClip.speed;
audio.play();

// On timeupdate:
if (audio.currentTime >= clip.start + clip.length) audio.pause();

// Progress display:
elapsed = audio.currentTime - clip.start;
total = clip.length;
```

Pitch shifting via Web Audio API + soundtouchjs. Only one PlayerBox plays at a time (enforced by `playerStore.activePlayerId`). Audio source: `GET /api/stream/:songId` (byte-range, lazy-loaded on play).

---

## Search

Query type detection is server-side. Frontend sends raw input:
- ASCII no spaces → pinyin initials (`zjl`)
- ASCII with spaces → full pinyin (`zhou jie lun`)
- CJK characters → Chinese fuzzy (`月亮`)

Search contexts:
1. **Library** — `GET /api/songs?q=...`
2. **Playlists page** — `GET /api/playlists?q=...`
3. **Within playlist** — client-side filter on loaded clips
4. **AddClipModal** — `GET /api/songs?q=...`
