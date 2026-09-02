const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const prisma = require('../db/client');
const captureService = require('../services/captureService');
const songPrefService = require('../services/songPrefService');
const songLibraryService = require('../services/songLibraryService');
const markedSongsService = require('../services/markedSongsService');
const { authMiddleware, requireApproved, requireActiveSession } = require('../middleware/auth');
const captureAuth = require('../middleware/captureAuth');
const { ADD_ONS, hasAddOn } = require('../utils/entitlements');
const settingsService = require('../services/settingsService');
const noEtag = require('../middleware/noEtag');

/**
 * Auto-tagging is sold separately from membership. Entitlements are not in the
 * JWT — they change while a session is live — so read them here. Only the
 * route that starts a run needs this; the rest act on a session that already
 * passed through it.
 */
async function requireCaptureAddOn(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { role: true, entitlements: true, tier: true },
    });
    const tiers = await settingsService.getTiers();
    if (!hasAddOn(user, ADD_ONS.CAPTURE, tiers)) {
      return res.status(403).json({
        error: {
          code: 'ADD_ON_REQUIRED',
          message: 'Auto-tagging is a paid add-on for members',
        },
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// GET /api/capture/version — checked by the client at startup.
// A 6-char code over a 31-char alphabet is ~900M combinations, but it is the
// only credential on this route, so cap guesses hard.
const pairLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many pairing attempts, try again later', status: 429 } },
});

// GET /api/capture/version — checked by the client at startup.
//
// Read from settings so shipping an APK needs no code change; see
// settingsService.getClientVersion for why, and for the version history that
// used to live here.
router.get('/version', noEtag, async (req, res, next) => {
  try {
    res.json(await settingsService.getClientVersion());
  } catch (err) {
    next(err);
  }
});

// POST /api/capture/pair — exchange a short code for the real token.
// Deliberately unauthenticated: the capture client has no user credentials,
// which is the whole reason pairing exists.
router.post('/pair', pairLimiter, async (req, res, next) => {
  try {
    res.json(await captureService.redeemPairCode(req.body && req.body.code));
  } catch (err) {
    next(err);
  }
});

// --- capture-token authenticated (the capture client) ---

// POST /api/capture/ingest — submit one captured title
// Auth is the capture token, NOT the login JWT, and requireActiveSession is
// deliberately absent: it would consume a device slot and evict the browser.
router.post('/ingest', captureAuth, async (req, res, next) => {
  try {
    // The session decides where a title goes, not the client. That is what
    // lets an old client -- which knows nothing about targets -- keep working
    // untouched while the destination moves underneath it.
    const target = req.captureSession.target;

    // Connected but not delivering: the user has paired and not yet said what
    // they are doing. Dropping is deliberate -- the alternative is guessing a
    // destination, and a wrong guess likes songs into a playlist everyone can
    // see. Still counts as contact, so the panel shows the client as alive.
    if (target === 'none') {
      // Said out loud, because this is the drop that looks like nothing is
      // wrong: the client heartbeats, the site shows connected, and every song
      // goes in the bin. A user sat through a whole game like that and
      // concluded the client was broken. The service logs its own drops, but
      // this one returns before reaching it.
      captureService.logNoTarget(req.captureSession, req.body && req.body.text, 'anything');
      await captureService.touchSession(req.captureSession);
      return res.json({ outcome: 'no_target' });
    }

    const result = target === 'live'
      ? await captureService.ingestLive({
        session: req.captureSession,
        rawText: req.body && req.body.text,
        // Both optional: clients before v15 send neither, and are read as
        // picking-screen captures with no words.
        lyric: req.body && req.body.lyric,
        stage: req.body && req.body.stage,
        // Which round the client is on. Absent from every build before the
        // one that added it, which is why de-duplication keeps its time
        // window as a fallback rather than requiring this.
        batchId: req.body && req.body.batchId,
      })
      : await captureService.ingestText({
        session: req.captureSession,
        rawText: req.body && req.body.text,
        // Optional: clients before v3 do not send it.
        side: req.body && req.body.side,
        // Optional: clients before v9 do not send it.
        row: req.body && req.body.row,
      });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/capture/heartbeat — "still here", for stretches with nothing to send.
// Without it a quiet client is indistinguishable from a dead one, and the panel
// reports a lost connection while capture is working fine.
router.post('/heartbeat', captureAuth, async (req, res, next) => {
  try {
    // The client reports its own build here, on a request it already makes.
    // Absent from every build before the one that added it, and absent is
    // left as-is rather than written as null — reconnecting with an old
    // client must not erase a newer answer.
    const result = await captureService.touchSession(
      req.captureSession,
      req.body && req.body.clientVersion,
    );
    // How the client learns which screens to scan. Carried on the heartbeat
    // rather than pushed, because the client already polls this and a second
    // channel would be one more thing to keep alive (item 13). Clients that
    // predate live mode ignore the extra field.
    res.json({
      ...result,
      mode: req.captureSession.mode,
      // What the newest build is, so a client can tell the user it is behind
      // without making a second request for it. Older clients ignore it.
      latestVersion: (await settingsService.getClientVersion()).latest,
      // What the client actually needs: which screens are worth scanning, and
      // whether to scan at all. Older clients ignore both fields.
      target: req.captureSession.target,
      // Which playlist, not just that there is one.
      //
      // Without this the client cannot see a move from one playlist to
      // another: target reads "playlist" before and after, so the string it
      // compares is unchanged and its already-sent set is never cleared. Every
      // song it had tagged into the first playlist was then skipped for the
      // second. Measured on production: across ten playlist switches, the
      // number of songs re-sent to the new destination was zero, every time.
      //
      // Null when the target is not a playlist, so "aimed at 唱卡" and "aimed
      // at no playlist in particular" stay distinguishable from each other.
      playlistId: req.captureSession.target === 'playlist'
        ? req.captureSession.playlistId : null,
    });
  } catch (err) {
    next(err);
  }
});

// --- JWT authenticated (the website) ---
const web = [authMiddleware, requireApproved, requireActiveSession];

// POST /api/capture/sessions — start a run; token is shown once
router.post('/sessions', ...web, requireCaptureAddOn, async (req, res, next) => {
  try {
    const { playlistId, label, ttlMinutes, mode } = req.body || {};

    // 唱卡 was admin-only while it was proven out. The reason was the client:
    // add-on holders ran a build that did not read the 唱卡 screens, so a live
    // run would have given them a session that could never receive anything.
    // Shipped clients have read those screens since v14 and the current build
    // is v21, so the add-on above is the whole gate now.
    const { session, token } = await captureService.startSession({
      userId: req.user.id, playlistId, label, ttlMinutes, mode,
    });
    res.json({
      token,
      // What the user actually types into the capture client. The long token
      // is returned too, for adb injection during development.
      pairCode: session.pairCode,
      pairExpiresAt: session.pairExpiresAt,
      session: {
        id: session.id,
        playlistId: session.playlistId,
        mode: session.mode,
        label: session.label,
        expiresAt: session.expiresAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/capture/connect — open a connection with no destination yet.
// The pairing code from here lasts the whole game: changing playlists moves the
// target rather than issuing a new token.
router.post('/connect', ...web, requireCaptureAddOn, async (req, res, next) => {
  try {
    const { label, ttlMinutes } = req.body || {};
    const { session, token } = await captureService.connect({
      userId: req.user.id, label, ttlMinutes,
    });
    res.json({
      token,
      pairCode: session.pairCode,
      pairExpiresAt: session.pairExpiresAt,
      session: {
        id: session.id,
        target: session.target,
        playlistId: session.playlistId,
        expiresAt: session.expiresAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/capture/connection — the current connection, or null.
// Polled by the nav indicator, which is on every page and has no session in
// mind; being disconnected answers null rather than 404.
router.get('/connection', ...web, async (req, res, next) => {
  try {
    const connection = await captureService.getConnection(req.user.id);
    const { latest } = await settingsService.getClientVersion();
    // Whether the connected client is behind. Decided here because the version
    // numbers live here; the service only reports what it recorded.
    //
    // A client that reports nothing is not called outdated: every build before
    // this one is silent, and telling those users to update on no evidence
    // would be a guess shown as a fact.
    res.json({
      connection: connection && {
        ...connection,
        latestVersion: latest,
        outdated: typeof connection.clientVersion === 'number'
          && connection.clientVersion < latest,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/capture/target — point the open connection somewhere, or nowhere.
router.patch('/target', ...web, requireCaptureAddOn, async (req, res, next) => {
  try {
    const { target, playlistId } = req.body || {};

    // No 唱卡 check here either, for the reason given on the session route: the
    // add-on is the gate, and the session was already found by userId.
    const session = await captureService.setTarget({
      userId: req.user.id, target, playlistId,
    });
    res.json({
      session: {
        id: session.id,
        target: session.target,
        playlistId: session.playlistId,
        expiresAt: session.expiresAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/capture/sessions/:id — stop a run
router.delete('/sessions/:id', ...web, async (req, res, next) => {
  try {
    res.json(await captureService.endSession({
      userId: req.user.id, sessionId: req.params.id,
    }));
  } catch (err) {
    next(err);
  }
});

// GET /api/capture/sessions/:id/status — is the capture client alive?
// Cheap enough to poll; the panel uses it to explain an empty list.
router.get('/sessions/:id/status', ...web, async (req, res, next) => {
  try {
    res.json(await captureService.getStatus({
      userId: req.user.id, sessionId: req.params.id,
    }));
  } catch (err) {
    next(err);
  }
});

// GET /api/capture/sessions/:id/report — events, summary, unmatched list
router.get('/sessions/:id/report', ...web, async (req, res, next) => {
  try {
    res.json(await captureService.getReport({
      userId: req.user.id, sessionId: req.params.id,
    }));
  } catch (err) {
    next(err);
  }
});

// GET /api/capture/sessions/:id/live — recent cards for a live run.
// The page calls this on load and again after an SSE reconnect, which is what
// makes a dropped push harmless: the events live in the database, not just on
// the wire.
router.get('/sessions/:id/live', ...web, async (req, res, next) => {
  try {
    res.json(await captureService.getLiveFeed({
      userId: req.user.id,
      sessionId: req.params.id,
      limit: Number(req.query.limit) || undefined,
    }));
  } catch (err) {
    next(err);
  }
});

// POST /api/capture/events/:id/approve — apply the like for this match
router.post('/events/:id/approve', ...web, async (req, res, next) => {
  try {
    res.json(await captureService.approveEvent({
      userId: req.user.id,
      eventId: req.params.id,
      clipId: req.body && req.body.clipId,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/capture/perf — temporary: where the wait before a key change goes.
 *
 * Shifting the key needs the whole track downloaded and decoded, and that is
 * slow on some phones while a desktop barely notices. The cure differs per
 * leg — an early fetch for a slow download, a different decoder or less audio
 * for a slow decode — and which one dominates has only been guessed at. These
 * are the real numbers, from the devices that actually have the problem.
 *
 * Logged rather than stored: a night of readings settles the question and a
 * table would outlive its usefulness. Remove this route with the client side.
 */
router.post('/perf', ...web, async (req, res, next) => {
  try {
    const b = req.body || {};
    const ms = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? Math.round(v) : null);
    console.log('[perf] ' + JSON.stringify({
      user: req.user.username,
      resolveMs: ms(b.resolveMs),
      downloadMs: ms(b.downloadMs),
      decodeMs: ms(b.decodeMs),
      bytes: ms(b.bytes),
      durationSec: ms(b.durationSec),
      source: typeof b.source === 'string' ? b.source.slice(0, 16) : null,
      tier: typeof b.tier === 'string' ? b.tier.slice(0, 16) : null,
      // Which device found it slow. The whole question is why some phones are
      // fine and others are not, and that cannot be answered without knowing
      // which is which. Truncated; nothing else about the singer is recorded.
      ua: String(req.headers['user-agent'] || '').slice(0, 160),
    }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/capture/events/:id/ignore — dismiss without liking
router.post('/events/:id/ignore', ...web, async (req, res, next) => {
  try {
    res.json(await captureService.ignoreEvent({
      userId: req.user.id, eventId: req.params.id,
    }));
  } catch (err) {
    next(err);
  }
});

// --- per-singer song preferences ---
//
// Gated on the capture add-on rather than on approval alone, matching every
// other 唱卡 route: these preferences exist only to be applied by the live
// page, so an account that cannot reach that page has nothing to store.
//
// Every handler takes the account from the verified token and never from the
// body. There is no shape of request that reads or writes another singer's
// preferences.

// GET /api/capture/prefs?keys=QQ:001abc,NETEASE:12345
// Batched: the live page asks once for every recording on screen.
const libraryQuery = z.object({
  q: z.string().max(200).optional(),
  cursor: z.string().uuid().optional(),
  take: z.coerce.number().int().min(1).max(100).optional(),
});

// GET /api/capture/library — search confirmed songs to mark ahead of time
//
// The reason this exists: a preference could only be set while its card was on
// screen, so the thought "this one is too high for me" arrived at the one
// moment there was no time to act on it. This lets the singer do it between
// games instead.
//
// Same gate as the rest of 唱卡, deliberately: this is part of that feature,
// not a separate one to be sold or granted on its own.
//
// No rate limit, because there is nothing to limit — the search reads our own
// database and never calls a platform, so the cost of browsing is one indexed
// query per keystroke against rows we already hold. Adding a limiter here
// would only punish someone typing quickly.
router.get('/library', ...web, requireCaptureAddOn, async (req, res, next) => {
  try {
    const parsed = libraryQuery.safeParse(req.query);
    // A cursor that is not a uuid reaches Postgres as a malformed uuid and
    // comes back as a 500 with the reason swallowed. Rejecting it here makes
    // a stale or hand-edited link say so plainly instead.
    if (!parsed.success) {
      return res.status(400).json({ error: { message: '参数不合法' } });
    }
    const { q, cursor, take } = parsed.data;
    return res.json(await songLibraryService.search(req.user.id, {
      query: q,
      cursor: cursor || null,
      take,
    }));
  } catch (err) {
    next(err);
  }
});

const markedQuery = z.object({
  q: z.string().max(200).optional(),
  // A checkbox arrives as the string "1"; anything else reads as off.
  hasNote: z.string().optional(),
  // Repeated ?color= params, or one comma-joined value — accept both and let
  // the service validate each to a hex colour.
  color: z.union([z.string(), z.array(z.string())]).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  take: z.coerce.number().int().min(1).max(100).optional(),
});

// GET /api/capture/marked — the singer's own marked songs (notes and colours)
//
// The 已标记 tab: a look back over what this singer put a note or a colour on,
// filterable by 有备注 and by colour. Same 唱卡 gate as the library, and the
// same property that makes browsing free — it reads only rows we already hold
// for this user and never calls a platform.
router.get('/marked', ...web, requireCaptureAddOn, async (req, res, next) => {
  try {
    const parsed = markedQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: { message: '参数不合法' } });
    }
    const { q, hasNote, color, offset, take } = parsed.data;
    const colors = color == null ? [] : (Array.isArray(color) ? color : [color]);
    return res.json(await markedSongsService.search(req.user.id, {
      query: q,
      hasNote: hasNote === '1',
      colors,
      offset: offset || 0,
      take,
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/prefs', ...web, requireCaptureAddOn, async (req, res, next) => {
  try {
    const raw = String(req.query.keys || '').trim();
    // Split on the separator, then on the FIRST colon only: a platform id is
    // opaque and may contain one.
    const keys = raw ? raw.split(',').map((pair) => {
      const at = pair.indexOf(':');
      if (at <= 0) return null;
      return { source: pair.slice(0, at), externalId: pair.slice(at + 1) };
    }).filter((k) => k && k.externalId) : [];

    const map = await songPrefService.getMany(req.user.id, keys);
    res.json({ prefs: Object.fromEntries(map) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/capture/prefs — store what this singer settled on
//
// A patch: fields that are absent are left alone, and an explicit null clears
// one. The card saves its key when it closes and its colours the moment they
// are clicked, so a whole-row write from either would discard the other.
router.put('/prefs', ...web, requireCaptureAddOn, async (req, res, next) => {
  try {
    const { source, externalId, pitch, speed, note, colorTag } = req.body || {};
    const fields = {};
    // Rebuilt key by key rather than spread, so a client cannot reach a column
    // this route does not mean to expose by adding it to the body.
    if (pitch !== undefined) fields.pitch = pitch;
    if (speed !== undefined) fields.speed = speed;
    if (note !== undefined) fields.note = note;
    if (colorTag !== undefined) fields.colorTag = colorTag;

    const prefs = await songPrefService.upsert(req.user.id, { source, externalId, ...fields });
    res.json({ prefs });
  } catch (err) {
    next(err);
  }
});

// PUT /api/capture/prefs/defaults — this singer's global key and tempo
//
// Applied to any song they have not set individually. Kept apart from the
// per-song route because it is a different thing: that one describes one
// recording, this one describes the singer.
router.put('/prefs/defaults', ...web, requireCaptureAddOn, async (req, res, next) => {
  try {
    const { pitch, speed } = req.body || {};
    const fields = {};
    if (pitch !== undefined) fields.pitch = pitch;
    if (speed !== undefined) fields.speed = speed;
    res.json({ defaults: await songPrefService.setDefaults(req.user.id, fields) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/capture/prefs — forget this recording entirely
router.delete('/prefs', ...web, requireCaptureAddOn, async (req, res, next) => {
  try {
    const { source, externalId } = req.body || {};
    res.json(await songPrefService.clear(req.user.id, { source, externalId }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
