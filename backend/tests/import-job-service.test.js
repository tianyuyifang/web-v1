const assert = require('assert');
const svc = require('../src/services/importJobService');

(async () => {
  // start + progress + done
  const id = svc.startImportJob('pl1', async (job) => {
    job.state = 'importing';
    job.progress.total = 2;
    job.progress.processed = 1;
    job.progress.added = 1;
    job.progress.processed = 2;
    job.result = { added: 2, skipped: 0, notFound: [], titleConflict: [] };
    Object.assign(job.progress, job.result);
  });
  assert.ok(id, 'returns jobId');

  // per-playlist lock: a slow active job blocks a second start on the same playlist
  svc.startImportJob('pl2', () => new Promise((r) => setTimeout(r, 200)));
  let threw = false;
  try {
    svc.startImportJob('pl2', async () => {});
  } catch (e) {
    threw = e.code === 'IMPORT_IN_PROGRESS' && e.status === 409;
  }
  assert.ok(threw, 'per-playlist lock throws IMPORT_IN_PROGRESS');

  // different playlist is not blocked
  const other = svc.startImportJob('pl-other', async () => {});
  assert.ok(other, 'different playlist not blocked');

  // wait for pl1 to finish
  await new Promise((r) => setTimeout(r, 60));
  const j = svc.getJob(id);
  assert.strictEqual(j.state, 'done', 'job reaches done');
  assert.strictEqual(j.result.added, 2, 'result carried');
  assert.strictEqual(j.progress.added, 2, 'progress final counts');

  // error path
  const eid = svc.startImportJob('pl3', async () => { throw new Error('boom'); });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(svc.getJob(eid).state, 'error', 'error state set');
  assert.strictEqual(svc.getJob(eid).error, 'boom', 'error message carried');

  // after pl2 slow job completes, its lock releases
  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual(svc.hasActiveJob('pl2'), false, 'lock released after completion');

  // unknown job
  assert.strictEqual(svc.getJob('nope'), null, 'unknown job -> null');

  console.log('import-job-service.test OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
