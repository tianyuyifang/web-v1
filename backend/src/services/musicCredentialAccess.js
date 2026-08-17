/**
 * Get a usable credential, renewing it first if it is close to expiring.
 *
 * Renewal happens here, on the way to an outbound call, rather than on a timer.
 * A schedule would have to run for every user whether or not they are using
 * the feature, and would keep refreshing accounts nobody touches; doing it at
 * the point of use means a credential is renewed exactly when it is about to
 * matter, and dormant accounts cost nothing.
 *
 * Only a scanned credential can be renewed at all — a pasted one has no
 * refresh key — so for those this is a plain read and the caller eventually
 * sees an expired-credential error, which the account page explains.
 *
 * Failure to renew is never fatal here. The stored credential might still have
 * hours left, so the call proceeds with what we have and the error surfaces
 * from the platform if it really is dead. Blocking on a failed renewal would
 * turn a maybe-still-working credential into a definitely-broken feature.
 */
const credentials = require('./musicCredentialService');
const qqLogin = require('./sources/qqLogin');
const qqSource = require('./sources/qqSource');

/** Store a renewed credential, keeping every field renewal itself needs. */
async function save(userId, fresh) {
  await credentials.setCredential(userId, 'qq', fresh.cookie, {
    method: 'qr',
    uin: fresh.uin,
    refreshKey: fresh.refreshKey,
    refreshToken: fresh.refreshToken,
    openid: fresh.openid,
    unionid: fresh.unionid,
    strMusicId: fresh.strMusicId,
    nickname: fresh.nickname,
    expiresAt: fresh.expiresAt,
    needRefreshInSec: fresh.needRefreshInSec,
  });
}

async function getFreshCredential(userId, platform) {
  if (platform !== 'qq') return credentials.getCredential(userId, platform);

  let renewed = false;
  try {
    if (await credentials.needsRefresh(userId, 'qq')) {
      const saved = await credentials.getRefreshable(userId, 'qq');
      if (saved) {
        await save(userId, await qqLogin.refreshCredential(saved));
        renewed = true;
      }
    }
  } catch (err) {
    // Recorded so the account page can say why, but not thrown: see above.
    await credentials.recordCheck(userId, 'qq', { ok: false, error: err.message })
      .catch(() => { /* bookkeeping only */ });
  }

  const cred = await credentials.getCredential(userId, platform);
  return cred ? { ...cred, renewed } : null;
}

/**
 * Renew once after the platform has already refused, then hand back the new
 * credential so the caller can retry.
 *
 * Scheduled renewal covers the expected case; this covers the unexpected one,
 * where a key dies earlier than the platform said it would. Deliberately a
 * single attempt with no loop: if the refresh key is dead too, the chain is
 * broken and only a fresh scan can fix it, so retrying would just be noise
 * against a platform that already said no.
 */
async function renewAfterRejection(userId) {
  const saved = await credentials.getRefreshable(userId, 'qq');
  if (!saved) return null;
  try {
    const fresh = await qqLogin.refreshCredential(saved);
    await save(userId, fresh);
    return credentials.getCredential(userId, 'qq');
  } catch (err) {
    await credentials.recordCheck(userId, 'qq', { ok: false, error: err.message })
      .catch(() => { /* bookkeeping only */ });
    return null;
  }
}

/**
 * Ask the platform who this credential belongs to and what it is worth.
 *
 * Called right after a credential is stored, because saving one only proves it
 * parsed. Whether it works, and whether the account has a subscription, are
 * things only the platform can answer — and the answer matters: 77% of the
 * imported playlist is VIP-only, so an account without one signs in perfectly
 * and then fails on most songs, which reads as a broken feature.
 *
 * Never throws. A failed check leaves the status unverified rather than
 * blocking the save, since the credential may well be fine and the page says
 * "not verified yet" either way.
 */
async function verifyCredential(userId, platform = 'qq') {
  if (platform !== 'qq') return null;
  try {
    const cred = await credentials.getCredential(userId, 'qq');
    if (!cred) return null;

    const info = await qqSource.getVipInfo({
      cookie: cred.cookie, uin: cred.uin, musicKey: cred.musicKey,
    });
    if (!info.ok) {
      return credentials.recordCheck(userId, 'qq', { ok: false, error: '凭证已失效' });
    }
    return credentials.recordCheck(userId, 'qq', {
      ok: true,
      vipType: info.vipType,
      vipExpiresOn: info.expiresOn,
    });
  } catch {
    return null;
  }
}

module.exports = { getFreshCredential, renewAfterRejection, verifyCredential };
