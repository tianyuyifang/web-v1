/**
 * A capture connection in use does not expire; an idle one still does.
 *
 * Before 2026-10-05 the end of a connection stayed where pairing put it (four
 * hours later), so a client heartbeating at hour four got a 401 mid-game and
 * had to be paired again. Each contact (touchSession: the heartbeat) now moves
 * the end to four hours from now.
 * Run: node tests/capture-sliding-expiry-test.js
 */
require('dotenv').config();
const assert = require('assert');
const prisma = require('../src/db/client');
const captureService = require('../src/services/captureService');

const H = 60 * 60 * 1000;
let pass = 0;
function ok(cond, what) {
  assert.ok(cond, what);
  pass += 1;
  console.log('  PASS', what);
}

(async () => {
  const user = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  assert.ok(user, 'need an ADMIN user');
  const made = [];
  const connect = async () => {
    const r = await captureService.connect({ userId: user.id, label: 'sliding-expiry-test' });
    made.push(r.sessionId || (r.session && r.session.id));
    return r;
  };
  const sessionIdOf = (r) => r.sessionId || (r.session && r.session.id);
  const row = (id) => prisma.captureSession.findUnique({ where: { id } });

  try {
    // 1. Paired almost four hours ago and in use: a heartbeat keeps it alive.
    {
      const r = await connect();
      const id = sessionIdOf(r);
      await prisma.captureSession.update({
        where: { id },
        data: { createdAt: new Date(Date.now() - 4 * H + 30000), expiresAt: new Date(Date.now() + 30000) },
      });
      await captureService.touchSession(await captureService.resolveSession(r.token));
      const after = await row(id);
      const left = new Date(after.expiresAt).getTime() - Date.now();
      ok(left > 3.9 * H && left <= 4 * H + 1000, `heartbeat at hour 4 moves the end to ~4 h from now (${(left / H).toFixed(2)} h)`);
      // What used to be the end has passed: still accepted.
      await prisma.captureSession.update({ where: { id }, data: { createdAt: new Date(Date.now() - 5 * H) } });
      ok(await captureService.resolveSession(r.token), 'past the original four hours, the token still works');
      // A second heartbeat later keeps sliding it.
      await prisma.captureSession.update({ where: { id }, data: { expiresAt: new Date(Date.now() + 5000) } });
      await captureService.touchSession(await captureService.resolveSession(r.token));
      ok(new Date((await row(id)).expiresAt).getTime() - Date.now() > 3.9 * H, 'every heartbeat slides it again');
    }

    // 2. Idle four hours: ends as before (no heartbeat, nothing moves it).
    {
      const r = await connect();
      const id = sessionIdOf(r);
      await prisma.captureSession.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      ok((await captureService.resolveSession(r.token)) === null, 'idle past its end: token refused (401) as before');
    }

    // 3. Ended stays ended: a heartbeat from a token resolved just before the
    //    end does not bring it back.
    {
      const r = await connect();
      const id = sessionIdOf(r);
      const s = await captureService.resolveSession(r.token);
      await prisma.captureSession.update({ where: { id }, data: { endedAt: new Date() } });
      await captureService.touchSession(s);
      const after = await row(id);
      ok(after.endedAt !== null, 'touch does not clear endedAt');
      ok((await captureService.resolveSession(r.token)) === null, 'an ended connection stays refused after a touch');
    }

    // 4. A longer window is never shortened.
    {
      const r = await connect();
      const id = sessionIdOf(r);
      const far = new Date(Date.now() + 20 * H);
      await prisma.captureSession.update({ where: { id }, data: { expiresAt: far } });
      await captureService.touchSession(await captureService.resolveSession(r.token));
      ok(new Date((await row(id)).expiresAt).getTime() === far.getTime(), 'a 20 h window stays 20 h');
    }

    // 5. One connection per user still holds: pairing again ends the old one,
    //    however recently it heartbeated.
    {
      const a = await connect();
      await captureService.touchSession(await captureService.resolveSession(a.token));
      const b = await connect();
      ok((await captureService.resolveSession(a.token)) === null, 'a new pairing still ends the old connection at once');
      ok(await captureService.resolveSession(b.token), 'the new one is live');
    }

    console.log(`\n${pass} passed`);
  } finally {
    const ids = made.filter(Boolean);
    if (ids.length) await prisma.captureSession.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
