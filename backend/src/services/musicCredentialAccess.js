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

async function getFreshCredential(userId, platform) {
  if (platform !== 'qq') return credentials.getCredential(userId, platform);

  let renewed = false;
  try {
    if (await credentials.needsRefresh(userId, 'qq')) {
      const saved = await credentials.getRefreshable(userId, 'qq');
      if (saved) {
        const fresh = await qqLogin.refreshCredential(saved);
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

module.exports = { getFreshCredential };
