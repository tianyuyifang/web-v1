/**
 * When a QQ credential is renewed, and how often.
 *
 * QQ answers needRefreshKeyIn 0 on every login; read as "renew now" that made
 * every use of a credential a renewal. These pin the corrected behaviour:
 * renew on the key's own lifetime, one renewal per user at a time, and a
 * cooldown after a failed one. QQ's login endpoint is stubbed: nothing leaves.
 *
 * Run: node tests/credential-renewal-test.js
 */
require('dotenv').config();
const assert = require('assert');

const loginPath = require.resolve('../src/services/sources/qqLogin');
const real = require(loginPath);
const calls = { n: 0, fail: false, failCode: null, platformCode: undefined, delayMs: 0 };
require.cache[loginPath].exports = {
  ...real,
  async refreshCredential(saved) {
    calls.n += 1;
    if (calls.delayMs) await new Promise((r) => setTimeout(r, calls.delayMs));
    if (calls.fail) {
      const e = new Error('refresh refused (stub)');
      if (calls.failCode) e.code = calls.failCode;
      if (calls.platformCode !== undefined) e.platformCode = calls.platformCode;
      throw e;
    }
    return {
      cookie: 'uin=10001; qm_keyst=W_Xrenewed' + calls.n,
      uin: '10001',
      refreshKey: 'rk', refreshToken: 'rt',
      loginType: 2, accessToken: 'at',
      expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      needRefreshInSec: 0,
    };
  },
};

const prisma = require('../src/db/client');
const credentials = require('../src/services/musicCredentialService');
const access = require('../src/services/musicCredentialAccess');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed += 1; console.log('  ✓', m); };

async function store(user, { expiresInH, needRefreshInSec, savedHoursAgo = 0 }) {
  await credentials.setCredential(user.id, 'qq', 'uin=10001; qm_keyst=W_Xold', {
    method: 'qr', uin: '10001', refreshKey: 'rk', refreshToken: 'rt',
    expiresAt: expiresInH == null ? null : new Date(Date.now() + expiresInH * 3600 * 1000).toISOString(),
    needRefreshInSec,
  });
  if (savedHoursAgo) {
    // Age the stored entry, as only time would.
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { preferences: true } });
    const prefs = row.preferences;
    prefs.musicSources.qq.savedAt = new Date(Date.now() - savedHoursAgo * 3600 * 1000).toISOString();
    await prisma.user.update({ where: { id: user.id }, data: { preferences: prefs } });
  }
}

async function prefsQq(user) {
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { preferences: true } });
  return row.preferences.musicSources.qq;
}

async function ageField(user, field, hours) {
  const row = await prisma.user.findUnique({ where: { id: user.id }, select: { preferences: true } });
  const prefs = row.preferences;
  prefs.musicSources.qq[field] = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  await prisma.user.update({ where: { id: user.id }, data: { preferences: prefs } });
}

(async () => {
  const user = await prisma.user.create({ data: { username: `__renew_${Date.now()}`, passwordHash: 'x', role: 'MEMBER' } });
  try {
    // needRefreshKeyIn 0 is not "now": a fresh 72h key is left alone.
    await store(user, { expiresInH: 72, needRefreshInSec: 0 });
    ok(await credentials.needsRefresh(user.id, 'qq') === false, '0 from QQ + 72h left: not due');
    calls.n = 0;
    for (let i = 0; i < 5; i += 1) await access.getFreshCredential(user.id, 'qq');
    ok(calls.n === 0, 'five uses of a fresh credential: no renewal (was five)');

    // Renewed once a day old (48h margin), so a once-a-day user is never late.
    await store(user, { expiresInH: 50, needRefreshInSec: 0 });
    ok(await credentials.needsRefresh(user.id, 'qq') === false, '50h left: not due');
    await store(user, { expiresInH: 47, needRefreshInSec: 0 });
    ok(await credentials.needsRefresh(user.id, 'qq') === true, '47h left (a day old): due');
    await store(user, { expiresInH: -2, needRefreshInSec: 0 });
    ok(await credentials.needsRefresh(user.id, 'qq') === true, 'already expired: due');
    // No stated expiry: renewed once a day old.
    await store(user, { expiresInH: null, needRefreshInSec: 0 });
    ok(await credentials.needsRefresh(user.id, 'qq') === false, 'no expiry, just saved: not due');
    await store(user, { expiresInH: null, needRefreshInSec: 0, savedHoursAgo: 25 });
    ok(await credentials.needsRefresh(user.id, 'qq') === true, 'no expiry, a day old: due');

    // A real positive answer from the platform is still honoured.
    await store(user, { expiresInH: 72, needRefreshInSec: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    ok(await credentials.needsRefresh(user.id, 'qq') === true, 'positive needRefreshKeyIn that has passed: due');

    // Several uses at once: one renewal.
    await store(user, { expiresInH: 6, needRefreshInSec: 0, savedHoursAgo: 66 });
    calls.n = 0; calls.delayMs = 200;
    const res = await Promise.all([1, 2, 3, 4].map(() => access.getFreshCredential(user.id, 'qq')));
    calls.delayMs = 0;
    ok(calls.n === 1, `four uses together: one renewal (${calls.n})`);
    ok(res.every((c) => c && c.musicKey === 'W_Xrenewed1'), 'all four get the renewed key');
    ok(await credentials.needsRefresh(user.id, 'qq') === false, 'renewed: no longer due');

    // A failed renewal is not retried on every use.
    await store(user, { expiresInH: 6, needRefreshInSec: 0, savedHoursAgo: 66 });
    calls.n = 0; calls.fail = true;
    const c1 = await access.getFreshCredential(user.id, 'qq');
    ok(c1 && c1.musicKey === 'W_Xold' && calls.n === 1, 'failure: one attempt, the stored credential is still returned');
    await access.getFreshCredential(user.id, 'qq');
    await access.getFreshCredential(user.id, 'qq');
    ok(calls.n === 1, 'within the cooldown: no further attempts (was one per use)');
    ok(await access.renewAfterRejection(user.id) === null && calls.n === 1, 'renewAfterRejection respects the cooldown too');
    calls.fail = false;

    // A rescan / manual renewal clears the cooldown.
    access.clearRenewCooldown(user.id);
    await store(user, { expiresInH: 6, needRefreshInSec: 0, savedHoursAgo: 66 });
    await access.getFreshCredential(user.id, 'qq');
    ok(calls.n === 2, 'after clearRenewCooldown: renews again');

    // QQ refusing cools down too (15 min rather than 1).
    await store(user, { expiresInH: 6, needRefreshInSec: 0, savedHoursAgo: 66 });
    calls.n = 0; calls.fail = true; calls.failCode = 'QR_REFRESH_FAILED'; calls.platformCode = 1000;
    await access.getFreshCredential(user.id, 'qq');
    await access.getFreshCredential(user.id, 'qq');
    ok(calls.n === 1, 'QQ refused: one attempt, then the cooldown');
    access.clearRenewCooldown(user.id);
    // One refusal is not the end: QQ answers busy moments with codes too.
    const after1 = await credentials.getRefreshable(user.id, 'qq');
    ok(!after1.renewRefusedAt, 'one refusal: renewal not stopped');
    ok(await credentials.needsRefresh(user.id, 'qq') === true, 'still due after one refusal');
    // A second refusal within the hour does not stop it either.
    await access.getFreshCredential(user.id, 'qq');
    access.clearRenewCooldown(user.id);
    ok(!(await credentials.getRefreshable(user.id, 'qq')).renewRefusedAt, 'two refusals within an hour: not stopped');
    // An answer with no code (QQ busy, no req_1) never counts.
    await store(user, { expiresInH: 6, needRefreshInSec: 0, savedHoursAgo: 66 });
    calls.platformCode = undefined;
    await access.getFreshCredential(user.id, 'qq');
    access.clearRenewCooldown(user.id);
    ok(!(await credentials.getRefreshable(user.id, 'qq')).renewRefusedAt && !(await prefsQq(user)).renewRefusalFirstAt, 'a refusal without a code does not count');
    // Refused, and again over an hour later: automatic renewal stops until a new scan.
    calls.platformCode = 1000;
    await access.getFreshCredential(user.id, 'qq');
    access.clearRenewCooldown(user.id);
    await ageField(user, 'renewRefusalFirstAt', 2);
    await access.getFreshCredential(user.id, 'qq');
    calls.fail = false; calls.failCode = null; calls.platformCode = undefined;
    access.clearRenewCooldown(user.id);
    ok((await credentials.getRefreshable(user.id, 'qq')).renewRefusedAt, 'refused twice an hour apart: stopped');
    ok(await credentials.needsRefresh(user.id, 'qq') === false, 'refused: not due again today');
    // A day later it is tried once more (QQ limiting this address heals by itself).
    await ageField(user, 'renewRefusedAt', 25);
    ok(await credentials.needsRefresh(user.id, 'qq') === true, 'refused a day ago: due once more');
    await ageField(user, 'renewRefusedAt', 1);
    const n0 = calls.n;
    await access.getFreshCredential(user.id, 'qq');
    ok(await access.renewAfterRejection(user.id) === null && calls.n === n0, 'refused: no renewal on a rejection either');
    await store(user, { expiresInH: 6, needRefreshInSec: 0, savedHoursAgo: 66 });
    ok(!(await credentials.getRefreshable(user.id, 'qq')).renewRefusedAt && await credentials.needsRefresh(user.id, 'qq') === true, 'a fresh connection clears it');
    // A rescan while a refused renewal was in flight is not marked.
    calls.n = 0; calls.fail = true; calls.failCode = 'QR_NOT_REFRESHABLE'; calls.delayMs = 300;
    const inflight = access.getFreshCredential(user.id, 'qq');
    await new Promise((r) => setTimeout(r, 100));
    await store(user, { expiresInH: 6, needRefreshInSec: 0, savedHoursAgo: 66 });
    await inflight;
    calls.fail = false; calls.failCode = null; calls.delayMs = 0;
    access.clearRenewCooldown(user.id);
    ok(!(await credentials.getRefreshable(user.id, 'qq')).renewRefusedAt, 'a credential saved during the refused renewal is not marked');

    // A refusal recorded with no code (final, no refresh key) must never touch
    // anything else in preferences -- jsonb_set with SQL NULL would wipe it all.
    await credentials.setCredential(user.id, 'netease', 'MUSIC_U=abc123; __csrf=x', { method: 'qr', refreshable: true });
    const savedAtNow = (await prefsQq(user)).savedAt;
    await credentials.markRenewRefused(user.id, 'qq', { platformCode: null, savedAt: savedAtNow, final: true });
    const rowAfter = await prisma.user.findUnique({ where: { id: user.id }, select: { preferences: true } });
    ok(rowAfter.preferences && rowAfter.preferences.musicSources && rowAfter.preferences.musicSources.netease
      && rowAfter.preferences.musicSources.qq.renewRefusedAt && rowAfter.preferences.musicSources.qq.cookie,
      'a refusal with no code keeps every other preference (and both credentials)');

    // A key minted minutes ago is not renewed on a rejection (QQ says
    // "expired" for a single withheld file too).
    await store(user, { expiresInH: 72, needRefreshInSec: 0 });
    calls.n = 0;
    ok(await access.renewAfterRejection(user.id) === null && calls.n === 0, 'rejection on a key minted just now: no renewal call');
    await store(user, { expiresInH: 70, needRefreshInSec: 0, savedHoursAgo: 2 });
    const renewed = await access.renewAfterRejection(user.id);
    ok(renewed && renewed.musicKey.startsWith('W_Xrenewed') && calls.n === 1, 'rejection on an older key: renewed once, new key returned');

    // An expiry that did not move forward on a renewal: still no renewal per
    // use while the key is under six hours old.
    await store(user, { expiresInH: 6, needRefreshInSec: 0, savedHoursAgo: 1 });
    calls.n = 0;
    for (let i = 0; i < 3; i += 1) await access.getFreshCredential(user.id, 'qq');
    ok(calls.n === 0, 'due by expiry but the key is 1h old: no scheduled renewal');

    // Refused on a key another request has since replaced: the stored one
    // comes back for the retry, without a renewal (and not "rescan").
    await store(user, { expiresInH: 72, needRefreshInSec: 0 });
    calls.n = 0;
    const swapped = await access.renewAfterRejection(user.id, 'W_Xsomething_older');
    ok(swapped && swapped.musicKey === 'W_Xold' && calls.n === 0, 'refused on a replaced key: the current key is returned, no renewal');
    ok(await access.renewAfterRejection(user.id, 'W_Xold') === null && calls.n === 0, 'refused on the current, minutes-old key: null, no renewal');

    // The renewed entry keeps what the next renewal needs.
    await store(user, { expiresInH: 6, needRefreshInSec: 0, savedHoursAgo: 66 });
    await access.getFreshCredential(user.id, 'qq');
    const kept = await credentials.getRefreshable(user.id, 'qq');
    ok(kept && kept.loginType === 2 && kept.accessToken === 'at', 'renewal keeps loginType and accessToken');

    console.log(`credential-renewal-test: all ${passed} checks passed`);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
