# Async Playlist Import Implementation Plan

**Goal:** Make QQ/NetEase/KuGou/xlsx playlist imports run as async background jobs with live progress, so large (300–1000 song) playlists no longer hit the 60s proxy timeout or partially fail.

**Architecture:** In-memory job registry (single fork-mode backend). `POST` starts a job → `202 { jobId }`; client polls `GET .../import/jobs/:jobId`. A shared optimized loop (`add-songs.js`) replaces the duplicated per-source loops, with bulk title prefetch, async ffmpeg, and progress callbacks. Per-playlist lock prevents concurrent imports.

**Tech Stack:** Express, Prisma/PostgreSQL, Node child_process, Next.js/React, nginx.

## Global Constraints

- Backend error format: `{ error: { message, status?, details? } }`; frontend reads `.error.message`.
- Import result shape (unchanged): `{ added: number, skipped: number, notFound: string[], titleConflict: {title, externalArtist, localArtist}[] }`.
- Job states: `'fetching' | 'importing' | 'done' | 'error'`.
- Concurrency: at most ONE active (`fetching`/`importing`) job per playlist → 409 `IMPORT_IN_PROGRESS` otherwise.
- Batched matcher MUST return the same song choice as the current per-song `findSongInDB` (incl. `pickMostPopular` for ambiguous titles).
- i18n: keep en.js / zh.js key parity.
- Middleware on import routes: `playlistAccess, requireOwner` (from `middleware/playlistAccess`).
- CLIP_LENGTH = 20 (unchanged).

---

## Task 1: Async ffmpeg helper

**Files:**
- Modify: `backend/scripts/clip-audio.js`
- Test: `backend/tests/clip-audio-async.test.js`

**Interfaces:**
- Produces: `clipAudioAsync({ sourcePath, outputPath, start, length, lyrics }) -> Promise<void>` (same semantics as `clipAudio`: ensure dir, skip if output exists, write .lrc when lyrics given). Keep existing sync `clipAudio` exported unchanged.

- [ ] **Step 1: Add `clipAudioAsync` alongside `clipAudio`.** Import `execFile` from `child_process` and `promisify` from `util`. Implementation:

```js
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

async function clipAudioAsync({ sourcePath, outputPath, start, length, lyrics }) {
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  if (fs.existsSync(outputPath)) return;
  await execFileP(ffmpegPath, [
    '-y', '-ss', String(start), '-t', String(length),
    '-i', sourcePath, '-c', 'copy', outputPath,
  ], { });
  if (lyrics) {
    const lrcPath = outputPath.replace(/\.mp3$/i, '.lrc');
    fs.writeFileSync(lrcPath, lyrics, 'utf-8');
  }
}
```

Update `module.exports = { clipAudio, clipAudioAsync };`

- [ ] **Step 2: Write test** `backend/tests/clip-audio-async.test.js` — clips a tiny fixture and asserts output + .lrc created, and skip-if-exists. Use an existing mp3 under the music dir if a fixture isn't available; otherwise assert the "skip if exists" branch resolves without spawning (create the output file first, then call and assert it returns fast). Minimal:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clipAudioAsync } = require('../scripts/clip-audio');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));
  const out = path.join(dir, 'x.mp3');
  fs.writeFileSync(out, 'existing'); // pre-existing → must skip ffmpeg
  await clipAudioAsync({ sourcePath: 'nonexistent.mp3', outputPath: out, start: 0, length: 5, lyrics: 'hi' });
  assert.strictEqual(fs.readFileSync(out, 'utf-8'), 'existing', 'skip-if-exists left file untouched');
  // lyrics only written on fresh clip; skip path must NOT write lrc
  assert.ok(!fs.existsSync(out.replace(/\.mp3$/, '.lrc')), 'no lrc written on skip');
  console.log('clip-audio-async.test OK');
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run** `cd backend && node tests/clip-audio-async.test.js` → `clip-audio-async.test OK`.
- [ ] **Step 4: Commit** `git add backend/scripts/clip-audio.js backend/tests/clip-audio-async.test.js && git commit -m "feat: add async clipAudioAsync (non-blocking ffmpeg)"`

---

## Task 2: Shared import loop with bulk prefetch + progress

**Files:**
- Create: `backend/scripts/lib/add-songs.js`
- Test: `backend/tests/add-songs.test.js`

**Interfaces:**
- Consumes: `findSongInDB`, `pickMostPopular` from `./find-song`; `clipAudioAsync` from `../clip-audio`; `sliceLRC` from `../../src/utils/lrc`; `prisma`.
- Produces: `addSongsToPlaylist(songs, targetPlaylistId, onProgress) -> Promise<{ added, skipped, notFound, titleConflict }>`. `songs`: `[{title, artist}]`. `onProgress(processed, total)` optional.

- [ ] **Step 1: Extract shared loop.** Port the exact loop body from `import-playlist-by-qq.js` (lines 75–165), generalized over `songs`. Add a **bulk title prefetch** before the loop that preserves matching semantics:

```js
const path = require('path');
const prisma = require('../../src/db/client');
const { sliceLRC } = require('../../src/utils/lrc');
const { clipAudioAsync } = require('../clip-audio');
const { findSongInDB, pickMostPopular } = require('./find-song');

const CLIP_LENGTH = 20;

function buildClipFilename(title, artist, start) {
  const artists = artist.split('_').map((a) => a.trim()).join(' & ');
  const safe = (s) => s.replace(/[<>:"/\\|?*]/g, '_');
  return `${safe(title)} - ${safe(artists)} - ${start}.mp3`;
}

// In-memory match against a prefetched title→candidates map, replicating
// findSongInDB's logic exactly (artist fuzzy match, else single, else popular).
async function matchSong(title, artist, byTitle) {
  const candidates = byTitle.get(title) || [];
  if (candidates.length === 0) return null;
  if (artist) {
    const ext = artist.split('_').map((a) => a.trim().toLowerCase());
    for (const song of candidates) {
      const db = song.artist.split('_').map((a) => a.trim().toLowerCase());
      if (ext.some((ea) => db.some((da) => da.includes(ea) || ea.includes(da)))) return song;
    }
  }
  if (candidates.length === 1) return candidates[0];
  return pickMostPopular(candidates);
}

async function addSongsToPlaylist(songs, targetPlaylistId, onProgress) {
  const total = songs.length;
  if (total === 0) return { added: 0, skipped: 0, notFound: [], titleConflict: [] };

  const mp3BasePath = process.env.MP3_BASE_PATH;
  const clipsBasePath = process.env.CLIPS_BASE_PATH;

  // Bulk prefetch all candidate songs by title (one query instead of N).
  const titles = [...new Set(songs.map((s) => s.title))];
  const allCandidates = await prisma.song.findMany({ where: { title: { in: titles } } });
  const byTitle = new Map();
  for (const s of allCandidates) {
    if (!byTitle.has(s.title)) byTitle.set(s.title, []);
    byTitle.get(s.title).push(s);
  }

  const existingSongs = await prisma.playlistClip.findMany({
    where: { playlistId: targetPlaylistId },
    include: { clip: { include: { song: { select: { title: true, artist: true } } } } },
  });
  const existingTitleMap = new Map();
  for (const pc of existingSongs) existingTitleMap.set(pc.clip.song.title, pc.clip.song.artist);

  const maxPos = await prisma.playlistClip.aggregate({
    where: { playlistId: targetPlaylistId }, _max: { position: true },
  });
  let position = (maxPos._max.position ?? -1) + 1;

  let added = 0, skipped = 0;
  const notFound = [], titleConflict = [];

  for (let i = 0; i < songs.length; i++) {
    const src = songs[i];
    const song = await matchSong(src.title, src.artist, byTitle);
    if (!song) { notFound.push(`${src.title} - ${src.artist}`); onProgress?.(i + 1, total); continue; }

    const existingArtist = existingTitleMap.get(song.title);
    if (existingArtist !== undefined) {
      const dbA = existingArtist.split('_').map((a) => a.trim().toLowerCase());
      const exA = song.artist.split('_').map((a) => a.trim().toLowerCase());
      if (exA.some((ea) => dbA.some((da) => da.includes(ea) || ea.includes(da)))) skipped++;
      else titleConflict.push({ title: song.title, externalArtist: src.artist, localArtist: existingArtist });
      onProgress?.(i + 1, total); continue;
    }

    const firstStart = song.starts ? parseInt(song.starts.split('|')[0], 10) : 0;
    let clip = await prisma.clip.findFirst({ where: { songId: song.id, start: firstStart, isGlobal: true } })
      || await prisma.clip.findFirst({ where: { songId: song.id, start: firstStart } });

    if (!clip) {
      const clipLyrics = sliceLRC(song.lyrics, firstStart, firstStart + CLIP_LENGTH);
      const clipFilename = buildClipFilename(song.title, song.artist, firstStart);
      const sourcePath = path.join(mp3BasePath, song.filePath);
      const outputPath = path.join(clipsBasePath, clipFilename);
      try {
        await clipAudioAsync({ sourcePath, outputPath, start: firstStart, length: CLIP_LENGTH, lyrics: clipLyrics });
      } catch (err) {
        console.warn(`  Warning: Could not clip "${song.title}": ${err.message}`);
      }
      clip = await prisma.clip.create({
        data: { songId: song.id, start: firstStart, length: CLIP_LENGTH, filePath: clipFilename, lyrics: clipLyrics },
      });
    }

    await prisma.playlistClip.create({ data: { playlistId: targetPlaylistId, clipId: clip.id, position } });
    existingTitleMap.set(song.title, song.artist);
    position++; added++;
    onProgress?.(i + 1, total);
  }

  return { added, skipped, notFound, titleConflict };
}

module.exports = { addSongsToPlaylist, buildClipFilename };
```

- [ ] **Step 2: Write test** `backend/tests/add-songs.test.js` for the `matchSong` parity logic (export it for testing or test via a small in-file copy). Assert: (a) title in map + artist match → that song; (b) single candidate no artist match → that song; (c) not in map → null; (d) multiple candidates no artist match → calls pickMostPopular. Mock `byTitle` as a plain Map; for (d) stub is not needed if you assert it returns one of the candidates. Keep it a pure-logic test (no DB) by testing `matchSong` with an injected `pickMostPopularFn` — refactor `matchSong` to accept the map only and keep pickMostPopular internal, OR export `matchSong` and pass candidates that are unambiguous so no DB is hit. Minimal deterministic cases (a),(b),(c):

```js
const assert = require('assert');
// Re-implement expectation against exported matchSong with unambiguous inputs.
const mod = require('../scripts/lib/add-songs');
// matchSong is internal; expose it for test:
assert.ok(typeof mod.addSongsToPlaylist === 'function');
console.log('add-songs.test OK (structure)');
```

(If `matchSong` is exported, add real assertions for (a)/(b)/(c). Export it.)

- [ ] **Step 3: Export `matchSong`** from add-songs.js (`module.exports = { addSongsToPlaylist, buildClipFilename, matchSong }`) and write real assertions:

```js
const { matchSong } = require('../scripts/lib/add-songs');
(async () => {
  const s1 = { id: 'a', title: 'T', artist: '周杰伦' };
  const byTitle = new Map([['T', [s1]]]);
  assert.strictEqual(await matchSong('T', '周杰伦', byTitle), s1, 'artist match');
  assert.strictEqual(await matchSong('T', 'nobody', byTitle), s1, 'single candidate fallback');
  assert.strictEqual(await matchSong('X', 'a', byTitle), null, 'not found');
  console.log('add-songs.test OK');
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run** `cd backend && node tests/add-songs.test.js` → `add-songs.test OK`.
- [ ] **Step 5: Commit** `git add backend/scripts/lib/add-songs.js backend/tests/add-songs.test.js && git commit -m "feat: shared import loop with bulk prefetch + async clip + progress"`

---

## Task 3: Refactor source importers to use the shared loop

**Files:**
- Modify: `backend/scripts/import-playlist-by-qq.js`
- Modify: `backend/scripts/import-playlist-by-netease.js`
- Modify: `backend/scripts/import-playlist-by-kugou.js`
- Modify: `backend/scripts/import-playlist-by-file.js`

**Interfaces:**
- Consumes: `addSongsToPlaylist` from `./lib/add-songs`.
- Produces (unchanged signatures): `importByQQ(id, targetId, onProgress)`, `fetchQQPlaylist(id)`; same for netease/kugou; `importByFile(buffer, targetId, onProgress)`. Add optional `onProgress` param threaded to `addSongsToPlaylist`.

- [ ] **Step 1: QQ** — replace the loop in `importByQQ` (lines 75–165) with:

```js
async function importByQQ(qqPlaylistId, targetPlaylistId, onProgress) {
  const qqSongs = await fetchQQPlaylist(qqPlaylistId);
  return addSongsToPlaylist(qqSongs, targetPlaylistId, onProgress);
}
```
Remove now-unused imports (`sliceLRC`, `clipAudio`, `findSongInDB`, `path` if unused, `buildClipFilename` local — keep `fetchQQPlaylist`, `execFile`, `path` for the scraper). Keep `require('./lib/add-songs')` at top. Also raise the scraper `timeout: 60000` → `180000`.

- [ ] **Step 2: NetEase** — same shape: `importByNetease` becomes fetch → `addSongsToPlaylist`. Thread `onProgress`.
- [ ] **Step 3: KuGou** — same; also raise `timeout: 60000` → `180000` in its `fetchKugouPlaylist`.
- [ ] **Step 4: File** — `importByFile` parses the buffer to `songs`, then `addSongsToPlaylist(songs, targetId, onProgress)`. (Inspect its current parse step; keep parsing, replace only the add loop.)
- [ ] **Step 5: Smoke-load** `cd backend && node -e "require('./scripts/import-playlist-by-qq');require('./scripts/import-playlist-by-netease');require('./scripts/import-playlist-by-kugou');require('./scripts/import-playlist-by-file');console.log('all importers load')"` → `all importers load`.
- [ ] **Step 6: Commit** `git add backend/scripts/import-playlist-by-*.js && git commit -m "refactor: source importers delegate to shared add-songs loop; raise scraper timeout"`

---

## Task 4: Import job service (in-memory registry + per-playlist lock)

**Files:**
- Create: `backend/src/services/importJobService.js`
- Test: `backend/tests/import-job-service.test.js`

**Interfaces:**
- Produces:
  - `startImportJob(playlistId, runner) -> jobId` (throws `ImportInProgressError` if active job exists for playlist).
  - `getJob(jobId) -> job | null`
  - `hasActiveJob(playlistId) -> boolean`
  - `ImportInProgressError` (class)
  - job shape: `{ id, playlistId, state, progress: { processed, total, added, skipped, notFound, titleConflict }, result, error, createdAt }`.

- [ ] **Step 1: Implement.** `runner(job)` is async; job service runs it detached and manages state/TTL.

```js
const crypto = require('crypto');

class ImportInProgressError extends Error {
  constructor() { super('An import is already running for this playlist'); this.code = 'IMPORT_IN_PROGRESS'; this.status = 409; }
}

const jobs = new Map(); // jobId -> job
const TTL_MS = 10 * 60 * 1000;

function hasActiveJob(playlistId) {
  for (const j of jobs.values()) {
    if (j.playlistId === playlistId && (j.state === 'fetching' || j.state === 'importing')) return true;
  }
  return false;
}

function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if ((j.state === 'done' || j.state === 'error') && now - j.finishedAt > TTL_MS) jobs.delete(id);
  }
}

function startImportJob(playlistId, runner) {
  if (hasActiveJob(playlistId)) throw new ImportInProgressError();
  const id = crypto.randomUUID();
  const job = {
    id, playlistId, state: 'fetching',
    progress: { processed: 0, total: 0, added: 0, skipped: 0, notFound: [], titleConflict: [] },
    result: null, error: null, createdAt: Date.now(), finishedAt: null,
  };
  jobs.set(id, job);
  // Run detached — do NOT await.
  Promise.resolve()
    .then(() => runner(job))
    .then(() => { job.state = 'done'; job.finishedAt = Date.now(); })
    .catch((err) => { job.state = 'error'; job.error = err.message || 'Import failed'; job.finishedAt = Date.now(); });
  return id;
}

function getJob(jobId) { sweep(); return jobs.get(jobId) || null; }

// periodic sweep so long-idle process still evicts
const sweepTimer = setInterval(sweep, TTL_MS);
if (sweepTimer.unref) sweepTimer.unref();

module.exports = { startImportJob, getJob, hasActiveJob, ImportInProgressError, _jobs: jobs };
```

- [ ] **Step 2: Test** `backend/tests/import-job-service.test.js`:

```js
const assert = require('assert');
const svc = require('../src/services/importJobService');

(async () => {
  // start + progress + done
  const id = svc.startImportJob('pl1', async (job) => {
    job.state = 'importing'; job.progress.total = 2;
    job.progress.processed = 1; job.progress.added = 1;
    job.progress.processed = 2; job.result = { added: 2, skipped: 0, notFound: [], titleConflict: [] };
  });
  assert.ok(id, 'returns jobId');
  // lock: second start while active throws (job may finish fast; force an active one)
  let threw = false;
  const slow = svc.startImportJob('pl2', () => new Promise((r) => setTimeout(r, 200)));
  try { svc.startImportJob('pl2', async () => {}); } catch (e) { threw = e.code === 'IMPORT_IN_PROGRESS'; }
  assert.ok(threw, 'per-playlist lock throws IMPORT_IN_PROGRESS');
  // wait for pl1 to finish
  await new Promise((r) => setTimeout(r, 50));
  const j = svc.getJob(id);
  assert.strictEqual(j.state, 'done');
  assert.strictEqual(j.result.added, 2);
  // error path
  const eid = svc.startImportJob('pl3', async () => { throw new Error('boom'); });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(svc.getJob(eid).state, 'error');
  assert.strictEqual(svc.getJob(eid).error, 'boom');
  // unknown job
  assert.strictEqual(svc.getJob('nope'), null);
  console.log('import-job-service.test OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run** `cd backend && node tests/import-job-service.test.js` → `import-job-service.test OK`.
- [ ] **Step 4: Commit** `git add backend/src/services/importJobService.js backend/tests/import-job-service.test.js && git commit -m "feat: in-memory import job service with per-playlist lock + TTL"`

---

## Task 5: Wire routes to start jobs and expose status

**Files:**
- Modify: `backend/src/routes/playlists.js`

**Interfaces:**
- Consumes: `startImportJob`, `getJob`, `ImportInProgressError` from `../services/importJobService`; the `importByX` functions.

- [ ] **Step 1: Import job service** at top of the import section (or with other requires). Add a helper to start a job from a runner and respond, handling the lock:

```js
const { startImportJob, getJob, ImportInProgressError } = require('../services/importJobService');

function startJobRoute(req, res, runner) {
  try {
    const jobId = startImportJob(req.params.id, runner);
    return res.status(202).json({ jobId });
  } catch (err) {
    if (err instanceof ImportInProgressError) {
      return res.status(409).json({ error: { message: err.message, code: err.code } });
    }
    throw err;
  }
}
```

- [ ] **Step 2: Rewrite `POST /:id/import/by-qq`:**

```js
router.post('/:id/import/by-qq', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const { importByQQ } = require('../../scripts/import-playlist-by-qq');
    const { qqPlaylistId } = req.body;
    if (!qqPlaylistId) return res.status(400).json({ error: { message: 'qqPlaylistId is required' } });
    startJobRoute(req, res, async (job) => {
      job.state = 'fetching';
      const result = await importByQQ(qqPlaylistId, req.params.id, (processed, total) => {
        job.state = 'importing'; job.progress.processed = processed; job.progress.total = total;
      });
      job.result = result;
      Object.assign(job.progress, result); // final counts
    });
  } catch (err) { next(err); }
});
```

- [ ] **Step 3: Same for by-netease, by-kugou, by-file** (file uses `req.file.buffer`; keep its multer setup). Each calls the matching `importByX(..., onProgress)` inside the runner.
- [ ] **Step 4: Add status route** (place BEFORE any conflicting `/:id/...` param routes are fine since path is distinct):

```js
router.get('/:id/import/jobs/:jobId', playlistAccess, requireOwner, async (req, res, next) => {
  try {
    const job = getJob(req.params.jobId);
    if (!job || job.playlistId !== req.params.id) {
      return res.status(404).json({ error: { message: 'Import job not found' } });
    }
    res.json({ state: job.state, progress: job.progress, result: job.result, error: job.error });
  } catch (err) { next(err); }
});
```

- [ ] **Step 5: Smoke-load** `cd backend && node -e "require('./src/routes/playlists');console.log('routes load')"` → `routes load`.
- [ ] **Step 6: Commit** `git add backend/src/routes/playlists.js && git commit -m "feat: import routes start async jobs (202 jobId) + job status endpoint"`

---

## Task 6: Frontend — start job, poll progress, handle states

**Files:**
- Modify: `frontend/src/lib/api.js`
- Modify: `frontend/src/components/playlist/ImportClipsModal.js`
- Modify: `frontend/src/i18n/en.js`, `frontend/src/i18n/zh.js`

- [ ] **Step 1: api.js** — the import methods already POST; ensure they return the axios response (they do). Add:

```js
getImportJob: (playlistId, jobId) => api.get(`/playlists/${playlistId}/import/jobs/${jobId}`),
```
(Place next to the existing `importClipsByQQ` etc. in `playlistsAPI`.)

- [ ] **Step 2: i18n** — add to en.js and zh.js (both):
  - `importFetching` — en `"Fetching playlist…"`, zh `"正在获取歌单…"`
  - `importProgress` — en `"Imported {n} of {total}"`, zh `"已导入 {n} / {total}"`
  - `importInterrupted` — en `"Import was interrupted — re-run to finish (already-added songs are skipped)."`, zh `"导入已中断 —— 重新运行即可完成（已添加的歌曲会自动跳过）。"`
  - `importAlreadyRunning` — en `"An import is already running for this playlist."`, zh `"该歌单已有导入任务正在进行。"`

- [ ] **Step 3: ImportClipsModal** — replace `doImport` with job start + poll. Track `progress` state. Poll every 1500ms; stop on done/error; clear on unmount.

```js
const pollRef = useRef(null);
const [progress, setProgress] = useState(null); // { state, processed, total }

useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

const doImport = async (startFn) => {
  setImporting(true); setImportError(""); setImportResult(null); setProgress(null);
  try {
    const res = await startFn();               // POST → { jobId }
    const jobId = res.data.jobId;
    pollRef.current = setInterval(async () => {
      try {
        const s = await playlistsAPI.getImportJob(playlistId, jobId);
        const j = s.data;
        setProgress({ state: j.state, ...j.progress });
        if (j.state === "done") {
          clearInterval(pollRef.current);
          setImporting(false); setProgress(null);
          setImportResult(j.result); onImported?.(j.result);
        } else if (j.state === "error") {
          clearInterval(pollRef.current);
          setImporting(false); setProgress(null);
          setImportError(j.error || t("importFailed"));
        }
      } catch (err) {
        if (err.response?.status === 404) {   // job vanished (restart)
          clearInterval(pollRef.current);
          setImporting(false); setProgress(null);
          setImportError(t("importInterrupted"));
        }
        // other transient errors: keep polling
      }
    }, 1500);
  } catch (err) {
    setImporting(false);
    if (err.response?.status === 409) setImportError(t("importAlreadyRunning"));
    else setImportError(err.response?.data?.error?.message || t("importFailed"));
  }
};
```

Update the handlers to pass the starter fn:
`const handleImportByQQ = () => { if (!qqId.trim()) return; doImport(() => playlistsAPI.importClipsByQQ(playlistId, qqId.trim())); };` (same pattern for netease/kugou/file — file passes the File).

- [ ] **Step 4: Progress UI** — replace the plain "importing" line with a progress indicator when `progress` is set:

```jsx
{importing && (
  <div className="py-4 text-center text-sm text-muted">
    {progress?.state === "importing" && progress.total
      ? t("importProgress").replace("{n}", progress.processed).replace("{total}", progress.total)
      : t("importFetching")}
    {progress?.state === "importing" && progress.total > 0 && (
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-border">
        <div className="h-full bg-primary transition-all"
             style={{ width: `${Math.round((progress.processed / progress.total) * 100)}%` }} />
      </div>
    )}
  </div>
)}
```

- [ ] **Step 5: Build** `cd frontend && npm run build` → no errors.
- [ ] **Step 6: Commit** `git add frontend/src/lib/api.js frontend/src/components/playlist/ImportClipsModal.js frontend/src/i18n/en.js frontend/src/i18n/zh.js && git commit -m "feat: async import UI — start job, poll progress, handle interrupted/in-progress"`

---

## Task 7: nginx scoped timeout (VM, deploy-time)

**Files:**
- Modify (on VM): `/etc/nginx/sites-enabled/music-app`

- [ ] Add a scoped location BEFORE the general `/api/` block (nginx picks the most specific prefix, so ordering isn't strictly required, but add it as its own block):

```
location /api/playlists/ {
    proxy_pass http://localhost:4000/api/playlists/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
}
```

- [ ] `sudo nginx -t && sudo systemctl reload nginx`. (Done during deploy, Task 9.)

---

## Task 8: Runtime verification (local)

- [ ] Start backend + frontend. Create a test playlist. In the import modal, import a QQ playlist id (use a real one the user provides, or a small known-good id). Observe: POST returns fast; progress bar advances; final ImportReport shows added/skipped/notFound. Verify clips appear in the playlist.
- [ ] Trigger the lock: start an import, immediately start another on the same playlist → second shows "already running" (409).
- [ ] Capture observations/screenshots.

---

## Task 9: Deploy

- [ ] Push to main. On VM: `git pull`, verify HEAD.
- [ ] No migration. `cd backend` (no prisma changes) → restart backend; `cd frontend && npm run build` → restart frontend.
- [ ] Apply nginx scoped-timeout block (Task 7), `nginx -t`, reload.
- [ ] Post-deploy smoke: import a moderately large QQ playlist through the live UI; confirm progress + completion, no 504.
