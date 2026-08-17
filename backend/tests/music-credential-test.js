/**
 * musicCredentialService tests. Touches the DB — creates and deletes one user.
 * Run: node tests/music-credential-test.js
 *
 * These store other people's QQ / NetEase login cookies. The rule the whole
 * module is built around is that a credential never reaches the browser, so
 * that is asserted first and hardest.
 */
const assert = require('assert');
const crypto = require('crypto');

require('dotenv').config();
process.env.MUSIC_VAULT_KEY = crypto.randomBytes(32).toString('hex');

const prisma = require('../src/db/client');
const svc = require('../src/services/musicCredentialService');

const KEY = 'SECRETKEY123';
// Invented, not a real account. A uin identifies a platform account for good,
// and these fixtures live in a public repository.
const UIN = '1000000000000000000';
const QQ_COOKIE = `qm_keyst=${KEY}; qqmusic_key=${KEY}; uin=${UIN}; wxuin=${UIN}; login_type=2`;

// --- cookie parsing (pure, no DB) ------------------------------------------
// A user pastes the whole cookie header rather than hunting for fields, and
// the field names differ by how they logged in: a WeChat login writes wxuin
// where a QQ login writes uin.
assert.strictEqual(svc.parseQqCookie(`uin=${UIN}; qm_keyst=K`).uin, UIN);
assert.strictEqual(svc.parseQqCookie(`wxuin=${UIN}; qm_keyst=K`).uin, UIN, 'WeChat alias');
assert.strictEqual(svc.parseQqCookie('qqmusic_uin=999; qm_keyst=K').uin, '999', 'third alias');
// QQ's web player writes the uin with an o-prefix; the vkey service wants the
// bare digits.
assert.strictEqual(svc.parseQqCookie(`uin=o0${UIN}; qm_keyst=K`).uin, UIN, 'o-prefix stripped');
// ...but a genuine leading zero is part of the number and must survive.
assert.strictEqual(svc.parseQqCookie('uin=0012345; qm_keyst=K').uin, '0012345', 'bare zeros kept');
assert.strictEqual(svc.parseQqCookie('qqmusic_key=K2; uin=1').musicKey, 'K2', 'key alias');

// Whether the credential can be renewed automatically depends on the presence
// of a refresh token, which a WeChat login does not get. The account page uses
// this to warn that the cookie needs repasting every few days.
assert.strictEqual(svc.parseQqCookie('qm_keyst=K; uin=1; psrf_qqrefresh_token=abc').refreshable, true);
// The real WeChat cookie has the field but leaves it blank — treating present
// -as-refreshable would promise a renewal that cannot happen.
assert.strictEqual(svc.parseQqCookie('qm_keyst=K; uin=1; psrf_qqrefresh_token=').refreshable, false,
  'an empty refresh token is not a refresh token');
assert.strictEqual(svc.parseQqCookie(QQ_COOKIE).refreshable, false, 'WeChat login is not refreshable');

assert.strictEqual(svc.parseNeteaseCookie('MUSIC_U=abc; os=pc').musicU, 'abc');
assert.strictEqual(svc.parseNeteaseCookie('os=pc').musicU, null);

(async () => {
  const user = await prisma.user.create({
    data: {
      username: `_cred_test_${Date.now()}`,
      passwordHash: 'x',
      preferences: { theme: 'dark', language: 'zh' },
    },
  });

  try {
    const before = await svc.getStatus(user.id);
    assert.strictEqual(before.length, 2, 'reports on every platform');
    assert.ok(before.every((p) => p.connected === false));

    const saved = await svc.setCredential(user.id, 'qq', QQ_COOKIE);
    assert.strictEqual(saved.connected, true);
    // Saving proves the cookie parsed, not that the platform accepts it, and
    // not that the account has VIP. Claiming otherwise would have the page
    // show a working connection that fails on the first song.
    assert.strictEqual(saved.vipType, null, 'unverified until the platform is asked');
    assert.strictEqual(saved.checkedAt, null);

    // --- the rule this module exists for ----------------------------------
    const exposed = JSON.stringify(await svc.getStatus(user.id));
    assert.ok(!exposed.includes(KEY), 'status never carries the music key');
    assert.ok(!exposed.includes('qm_keyst'), 'nor any cookie fragment');
    assert.ok(!exposed.includes(UIN), 'nor the platform account id');

    // --- encrypted at rest -------------------------------------------------
    const row = await prisma.user.findUnique({
      where: { id: user.id }, select: { preferences: true },
    });
    assert.ok(!JSON.stringify(row.preferences).includes(KEY), 'plaintext is not in the database');
    assert.ok(row.preferences.musicSources.qq.cookie.startsWith('v1.'), 'stored in the vault envelope');

    // preferences also holds theme and language; a blind write would reset them.
    assert.strictEqual(row.preferences.theme, 'dark', 'unrelated preferences survive');
    assert.strictEqual(row.preferences.language, 'zh');

    // --- server-side retrieval --------------------------------------------
    const cred = await svc.getCredential(user.id, 'qq');
    assert.strictEqual(cred.musicKey, KEY);
    assert.strictEqual(cred.uin, UIN);
    assert.strictEqual(cred.cookie, QQ_COOKIE, 'the full header round-trips for outbound calls');

    // --- what the platform said -------------------------------------------
    let checked = await svc.recordCheck(user.id, 'qq', { ok: true, vipType: 11, nickname: '测试' });
    assert.strictEqual(checked.vipType, 11);
    assert.strictEqual(checked.nickname, '测试');
    assert.ok(checked.checkedAt);

    checked = await svc.recordCheck(user.id, 'qq', { ok: false, error: 'expired' });
    assert.strictEqual(checked.lastError, 'expired');
    // A transient failure must not erase what we know about the account, or
    // the page would flip to "no VIP" on one bad call.
    assert.strictEqual(checked.vipType, 11, 'known VIP survives a failed check');

    // --- refusals ----------------------------------------------------------
    // These raise the project's ValidationError so the error handler answers
    // 400 with the message intact. A bare Error carrying .status became a 500
    // with the message replaced by "Internal server error", which told the
    // user their cookie was fine and the server was broken.
    const isBadRequest = (e) => e.statusCode === 400 && Boolean(e.isOperational);
    for (const cookie of ['nothing=here', `uin=${UIN}`, 'qm_keyst=abc', '', '   ']) {
      await assert.rejects(() => svc.setCredential(user.id, 'qq', cookie),
        isBadRequest, `rejects ${JSON.stringify(cookie)} as a bad request`);
    }
    await assert.rejects(() => svc.setCredential(user.id, 'netease', 'os=pc'),
      isBadRequest, 'NetEase needs MUSIC_U');
    await assert.rejects(() => svc.setCredential(user.id, 'spotify', 'x=1'),
      isBadRequest, 'an unknown platform is a bad request, not a crash');

    // --- platforms are independent ----------------------------------------
    await svc.setCredential(user.id, 'netease', 'MUSIC_U=abc123');
    await svc.clearCredential(user.id, 'qq');
    assert.strictEqual((await svc.getStatus(user.id, 'qq')).connected, false);
    assert.strictEqual((await svc.getStatus(user.id, 'netease')).connected, true,
      'clearing one platform leaves the other alone');
    assert.strictEqual(await svc.getCredential(user.id, 'qq'), null,
      'a cleared credential reads as absent, so the UI can offer to reconnect');

    const after = await prisma.user.findUnique({
      where: { id: user.id }, select: { preferences: true },
    });
    assert.strictEqual(after.preferences.theme, 'dark', 'theme survived every write');

    console.log('music-credential tests passed');
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
