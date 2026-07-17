# Async Playlist Import — Design

**Date:** 2026-07-17

## Problem

Importing a QQ Music (and NetEase/KuGou/xlsx) playlist into a local playlist runs
as **one synchronous HTTP request** that processes songs in a **serial, blocking
loop**. For large playlists (300–1000 songs) this:

- Exceeds nginx's default 60s `proxy_read_timeout` on `/api/` → the user gets a
  504 and sees "failure," while the backend keeps working. Because each song is
  committed independently, the playlist ends up **partially imported** with no
  clear result shown.
- Blocks the Node event loop: `clipAudio` uses `execFileSync` (blocking ffmpeg
  per new clip), freezing the whole backend for other users during the import.
- Does one title lookup per song (`findSongInDB` → `findMany`), plus 2–3 clip
  queries and 2 inserts per song = 1500+ serial DB round-trips for 300 songs.
- Offers no progress and no way to know what happened on failure.

## Root causes (confirmed)

1. nginx `/api/` has no `proxy_read_timeout` → default 60s.
2. `clipAudio` is synchronous/blocking (`execFileSync`).
3. Per-song serial DB queries; duplicated identical loops across qq/netease/kugou.
4. One long request with result only at the very end; no progress, no resumability.

## Solution: async background job + shared optimized loop

Single-process fork-mode backend (confirmed via `pm2 jlist` and existing in-memory
SSE manager), so an **in-memory job registry** is safe — no Redis/DB queue needed.

### 1. Shared import loop (removes duplication)

New module `backend/scripts/lib/add-songs.js`:

```
addSongsToPlaylist(songs, targetPlaylistId, onProgress) -> { added, skipped, notFound, titleConflict }
```

- `songs`: `[{ title, artist }]` (already scraped/parsed by the source-specific fetcher).
- `onProgress(processed, total)`: called after each song so the job can report live counts.
- Contains the loop currently duplicated in qq/netease/kugou importers.
- Optimizations:
  - **Bulk title prefetch:** one `song.findMany({ where: { title: { in: uniqueTitles } } })`
    up front → `Map<title, candidates[]>`. Per-song matching then works in memory;
    `pickMostPopular` still runs only for ambiguous (multi-candidate, no artist match) titles.
  - **Async ffmpeg:** use a new `clipAudioAsync` (await `execFile`) so the event
    loop is not frozen during import.
  - **Yield** to the event loop periodically (already implied by awaits).

The qq/netease/kugou/file importers keep their `fetchX()` and become thin:
fetch → `addSongsToPlaylist(songs, targetId, onProgress)`.

### 2. Async ffmpeg

`backend/scripts/clip-audio.js` gains `clipAudioAsync({...})` returning a Promise
(wraps `execFile`), same behavior as `clipAudio` (skip-if-exists, write .lrc).
Keep the sync `clipAudio` for any existing callers (clipService); the import path
uses the async one.

### 3. Job service (in-memory)

New `backend/src/services/importJobService.js`:

- `Map<jobId, job>`; `job = { id, playlistId, state, progress, result, error, createdAt }`.
- `state`: `'fetching' | 'importing' | 'done' | 'error'`.
- `progress`: `{ processed, total, added, skipped, notFound, titleConflict }`.
- `startImportJob(playlistId, runner)`: creates a job, kicks off `runner(job)` in the
  background (not awaited), returns `jobId`. **Throws `ImportInProgressError` if the
  playlist already has a `fetching`/`importing` job** (per-playlist lock — prevents
  two concurrent imports from assigning overlapping positions / duplicate clips).
- `getJob(jobId)`: returns the job (or null).
- `hasActiveJob(playlistId)`: true if a `fetching`/`importing` job exists for it.
- TTL cleanup: evict jobs `done`/`error` older than 10 min (lazy sweep on access + interval).
  Active jobs are never evicted.

The `runner` is source-specific glue:
`async (job) => { job.state='fetching'; const songs = await fetchX(id); job.progress.total = songs.length; job.state='importing'; const r = await addSongsToPlaylist(songs, playlistId, (p,t)=>{job.progress.processed=p; job.progress.total=t;}); job.result=r; job.state='done'; }`
Wrapped in try/catch → `job.state='error'; job.error=msg`.

### 4. Routes

- `POST /api/playlists/:id/import/by-qq` (and by-netease, by-kugou, by-file): now
  validate input, then `startImportJob(...)`, respond `202 { jobId }` immediately.
  If a job is already active for the playlist → `409 { error: { message, code: 'IMPORT_IN_PROGRESS' } }`.
- `GET /api/playlists/:id/import/jobs/:jobId`: returns
  `{ state, progress, result?, error? }`. `playlistAccess` + `requireOwner`. The
  job's `playlistId` must equal `:id` (else 404) — guards cross-playlist job access.

Existing `compare/qq` etc. routes are unchanged (they're read-only and fast).

### 5. Frontend (`ImportClipsModal`)

- `doImport` starts the job → gets `jobId`, then **polls**
  `GET .../import/jobs/:jobId` every 1500ms.
- While `fetching`: show "Fetching playlist…". While `importing`: show a progress
  bar `processed / total` + running added/skipped counts.
- On `done`: show existing `ImportReport` with `result`. On `error`: show message.
- **Job vanished (404 while polling)** — e.g. backend restarted mid-import: treat as
  a soft state, show "Import was interrupted — re-run to finish (already-added songs
  are skipped)," NOT a hard crash. Import is idempotent so a re-run completes it.
- **409 IMPORT_IN_PROGRESS** on start: show "An import is already running for this
  playlist."
- Polling is cancelled if the modal unmounts, but the **job keeps running server-side**.
- `playlistsAPI` gains `getImportJob(playlistId, jobId)` and the import methods
  return `{ jobId }`.

### 6. nginx (defense-in-depth)

Add a **scoped** `location /api/playlists/` (or a dedicated import location) with
`proxy_read_timeout 300s`, rather than raising the global `/api/` timeout. This
keeps other routes at nginx's 60s default (a hung request there still fails fast)
while giving the import `POST` headroom for a briefly-slow scrape. With the job
design the long work no longer rides one request, so this is pure defense-in-depth.

### 7. Scraper timeout

Raise the Python scraper `execFile` timeout from 60s to 180s (qq + kugou) so a
large-playlist fetch inside the job doesn't fail at the scrape step.

## Side effects addressed

- **Concurrent imports on one playlist** → per-playlist job lock (409 if active);
  prevents overlapping positions / duplicate clips.
- **Backend restart mid-import** → data safe (idempotent, per-song commits); client
  handles a vanished job as a soft "re-run to finish" state.
- **Async ffmpeg** → within a job, songs process one-at-a-time, so at most one
  ffmpeg per job; the lock bounds it to one import per playlist.
- **API-shape change (`202 { jobId }`)** → only caller is `ImportClipsModal`,
  updated in the same change; deploy client+server together.
- **Job registry memory** → 10-min TTL + lazy sweep; active jobs never evicted.
- **Bulk prefetch parity** → batched matcher unit-tested to match per-song results
  on ambiguous/not-found/conflict cases; `pickMostPopular` DB path unchanged.
- **nginx timeout** → scoped to the import location, not global `/api/`.

## Idempotency / partial-import safety

Each song commits independently and existing titles are skipped via the in-playlist
title map, so **re-running an import is idempotent** — already-added songs are
skipped, and the report shows added/skipped/notFound/titleConflict explicitly. A
job that errors mid-way leaves a valid partial state that a re-run completes.

## Testing

- Unit: `add-songs.js` bulk-prefetch matching (title in map, ambiguous → pickMostPopular,
  not found, title conflict, skip same-artist duplicate).
- Unit: `importJobService` lifecycle (start → progress updates → done; error path; TTL evict).
- Integration/runtime: start an import against a real playlist, poll the job endpoint,
  observe progress advancing and a final report; verify clips land in the playlist.

## Out of scope (YAGNI)

- Persisting jobs across backend restarts (in-memory is fine for fork mode; a restart
  mid-import just means re-run, which is idempotent).
- Cancellation of a running job.
- Parallelizing ffmpeg across workers (async unblocks the loop; that's enough).
- Changing the matching/popularity logic itself.
