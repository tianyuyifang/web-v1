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
const neteaseLogin = require('./sources/neteaseLogin');

/** Store a renewed credential, keeping every field renewal itself needs. */
async function save(userId, fresh) {
  await credentials.setCredential(userId, 'qq', fresh.cookie, {
    method: 'qr',
    uin: fresh.uin,
    // Kept as the manual renewal (routes/musicSources /qq/refresh) keeps
    // them: without loginType the next renewal guesses the parameter set from
    // the key's prefix, which misreads an app-QR (type 6) login.
    loginType: fresh.loginType,
    accessToken: fresh.accessToken,
    refreshKey: fresh.refreshKey,
    refreshToken: fresh.refreshToken,
    openid: fresh.openid,
    unionid: fresh.unionid,
    strMusicId: fresh.strMusicId,
    encryptUin: fresh.encryptUin,
    nickname: fresh.nickname,
    expiresAt: fresh.expiresAt,
    needRefreshInSec: fresh.needRefreshInSec,
  });
}

/**
 * One renewal per user at a time, and none for a while after one failed.
 *
 * Several requests for the same user arrive together (a page opening, a run
 * starting), and each would otherwise start its own renewal of the same
 * account -- the shape the reference client avoids with a per-account lock.
 * And a renewal that fails (a dead refresh key) would otherwise be retried on
 * every single use, each attempt a login call from this server's address that
 * cannot succeed. The cooldown is short enough that a passing network fault
 * heals within minutes.
 */
const RENEW_COOLDOWN_MS = 15 * 60 * 1000;
// A network fault or a garbled answer is not the platform refusing: tried
// again a minute later rather than a quarter of an hour.
const RENEW_TRANSIENT_COOLDOWN_MS = 60 * 1000;
// A key minted this recently is not dead: QQ answers "credential expired" for
// a single withheld file too, and renewing on every such tap was a login call
// per tap that could not help.
const RENEW_MIN_AGE_MS = 10 * 60 * 1000;
// A scheduled renewal never for a key under six hours old, whatever the
// stored expiry says: if a renewal ever came back without moving the expiry
// forward, each use would otherwise renew again (the old pattern). At most
// four a day per user, even then. Checked inside the single flight, so a use
// that read "due" just before another request's renewal landed does not
// renew a second time.
const SCHEDULED_MIN_AGE_MS = 6 * 60 * 60 * 1000;
const renewing = new Map(); // userId -> Promise<boolean>
const renewFailedAt = new Map(); // userId -> { at, ms }

function inCooldown(userId) {
  const f = renewFailedAt.get(userId);
  if (!f) return false;
  if (Date.now() - f.at < f.ms) return true;
  renewFailedAt.delete(userId);
  return false;
}

/** A credential was stored afresh (scan, paste, manual renewal): its renewals start clean. */
function clearRenewCooldown(userId) {
  renewFailedAt.delete(userId);
}

function ageMs(saved) {
  const at = saved.savedAt ? new Date(saved.savedAt).getTime() : NaN;
  return Number.isNaN(at) ? Infinity : Date.now() - at;
}

/**
 * Renew this user's QQ credential once; true when a fresh one was stored.
 * Not when the stored key is younger than `minAgeMs`.
 */
function renewOnce(userId, minAgeMs = 0) {
  const inFlight = renewing.get(userId);
  if (inFlight) return inFlight;
  const p = (async () => {
    const saved = await credentials.getRefreshable(userId, 'qq');
    if (!saved || saved.renewBlocked || ageMs(saved) < minAgeMs) return false;
    try {
      await save(userId, await qqLogin.refreshCredential(saved));
      renewFailedAt.delete(userId);
      console.log(`[renew] ok user=${userId}`);
      return true;
    } catch (err) {
      const refused = err.code === 'QR_REFRESH_FAILED' || err.code === 'QR_NOT_REFRESHABLE';
      renewFailedAt.set(userId, { at: Date.now(), ms: refused ? RENEW_COOLDOWN_MS : RENEW_TRANSIENT_COOLDOWN_MS });
      if (renewFailedAt.size > 5000) renewFailedAt.clear();
      // The platform's own code, so which refusals are final can be told
      // apart later; a refusal stops automatic renewal until the user
      // connects again or renews by hand (markRenewRefused).
      console.log(`[renew] ${refused ? 'refused' : 'failed'} user=${userId} code=${err.code}${err.platformCode != null ? `/${err.platformCode}` : ''}`);
      if (refused) {
        await credentials.markRenewRefused(userId, 'qq', {
          platformCode: err.platformCode,
          savedAt: saved.savedAt,
          final: err.code === 'QR_NOT_REFRESHABLE',
        }).catch(() => { /* bookkeeping only */ });
      }
      // Recorded so the account page can say why, but not thrown: see above.
      await credentials.recordCheck(userId, 'qq', { ok: false, error: err.message })
        .catch(() => { /* bookkeeping only */ });
      return false;
    }
  })().finally(() => renewing.delete(userId));
  renewing.set(userId, p);
  return p;
}

async function getFreshCredential(userId, platform) {
  if (platform !== 'qq') return credentials.getCredential(userId, platform);

  let renewed = false;
  try {
    if (!inCooldown(userId) && await credentials.needsRefresh(userId, 'qq')) {
      renewed = await renewOnce(userId, SCHEDULED_MIN_AGE_MS);
    }
  } catch (err) {
    // needsRefresh reading the store failed: proceed with what is stored.
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
async function renewAfterRejection(userId, usedKey = null) {
  // Another request renewed it meanwhile: the caller was refused on the old
  // key, and the stored one is worth the one retry -- no renewal needed.
  const stored = await credentials.getCredential(userId, 'qq');
  if (stored && usedKey && stored.musicKey && stored.musicKey !== usedKey) return stored;
  // A renewal that failed minutes ago will fail again: the chain is broken
  // until the user rescans, and asking again is only noise from our address.
  if (inCooldown(userId)) return null;
  const saved = await credentials.getRefreshable(userId, 'qq');
  // Refused before: only a fresh connection (or a renewal by hand) helps.
  if (!saved || saved.renewBlocked || ageMs(saved) < RENEW_MIN_AGE_MS) return null;
  const ok = await renewOnce(userId, RENEW_MIN_AGE_MS);
  return ok ? credentials.getCredential(userId, 'qq') : null;
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
  if (platform === 'netease') return verifyNetease(userId);
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

/**
 * The NetEase counterpart.
 *
 * Reported as a plain yes/no rather than mapped onto QQ's tiers: NetEase uses
 * its own scale (11 seen on a live 黑胶VIP account), and pretending the numbers
 * mean the same thing would put a wrong label on the page.
 */
async function verifyNetease(userId) {
  try {
    const cred = await credentials.getCredential(userId, 'netease');
    if (!cred) return null;

    const info = await neteaseLogin.getAccountInfo(cred.cookie);
    if (!info.ok) {
      return credentials.recordCheck(userId, 'netease', { ok: false, error: '凭证已失效' });
    }
    return credentials.recordCheck(userId, 'netease', {
      ok: true,
      // Normalised to 0/1 so the page can render one rule for both platforms.
      vipType: info.vipType > 0 ? 1 : 0,
      nickname: info.nickname,
    });
  } catch {
    return null;
  }
}

module.exports = { getFreshCredential, renewAfterRejection, verifyCredential, clearRenewCooldown };
