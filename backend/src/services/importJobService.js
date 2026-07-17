/**
 * importJobService.js
 *
 * In-memory registry for async playlist-import jobs. The backend runs as a single
 * fork-mode PM2 process (same assumption as the in-memory SSE manager), so job
 * state lives in a module-level Map — no external queue needed.
 *
 * A job runs its `runner(job)` detached (not awaited by the HTTP request), so the
 * POST returns immediately with a jobId and the client polls getJob() for progress.
 * At most one active (fetching/importing) job per playlist is allowed.
 */

const crypto = require('crypto');

class ImportInProgressError extends Error {
  constructor() {
    super('An import is already running for this playlist');
    this.code = 'IMPORT_IN_PROGRESS';
    this.status = 409;
  }
}

const jobs = new Map(); // jobId -> job
const TTL_MS = 10 * 60 * 1000; // finished jobs evicted after 10 min

function hasActiveJob(playlistId) {
  for (const j of jobs.values()) {
    if (j.playlistId === playlistId && (j.state === 'fetching' || j.state === 'importing')) {
      return true;
    }
  }
  return false;
}

function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if ((j.state === 'done' || j.state === 'error') && j.finishedAt && now - j.finishedAt > TTL_MS) {
      jobs.delete(id);
    }
  }
}

/**
 * Create a job and run `runner(job)` in the background. The runner mutates
 * job.state / job.progress / job.result as it goes.
 *
 * @param {string} playlistId
 * @param {(job: object) => Promise<void>} runner
 * @returns {string} jobId
 * @throws {ImportInProgressError} if the playlist already has an active job
 */
function startImportJob(playlistId, runner) {
  if (hasActiveJob(playlistId)) throw new ImportInProgressError();

  const id = crypto.randomUUID();
  const job = {
    id,
    playlistId,
    state: 'fetching',
    progress: { processed: 0, total: 0, added: 0, skipped: 0, notFound: [], titleConflict: [] },
    result: null,
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);

  // Detached — do NOT await. Terminal state is set here so the runner only has
  // to do the work and update progress.
  Promise.resolve()
    .then(() => runner(job))
    .then(() => {
      job.state = 'done';
      job.finishedAt = Date.now();
    })
    .catch((err) => {
      job.state = 'error';
      job.error = err.message || 'Import failed';
      job.finishedAt = Date.now();
    });

  return id;
}

function getJob(jobId) {
  sweep();
  return jobs.get(jobId) || null;
}

// Periodic sweep so a long-idle process still evicts finished jobs.
const sweepTimer = setInterval(sweep, TTL_MS);
if (sweepTimer.unref) sweepTimer.unref();

module.exports = { startImportJob, getJob, hasActiveJob, ImportInProgressError, _jobs: jobs };
