const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const prisma = require('../db/client');
const captureService = require('../services/captureService');
const { authMiddleware, requireApproved, requireActiveSession } = require('../middleware/auth');
const captureAuth = require('../middleware/captureAuth');
const { ADD_ONS, hasAddOn } = require('../utils/entitlements');

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
      select: { role: true, entitlements: true },
    });
    if (!hasAddOn(user, ADD_ONS.CAPTURE)) {
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

// --- unauthenticated: pairing ---

// A 6-char code over a 31-char alphabet is ~900M combinations, but it is the
// only credential on this route, so cap guesses hard.
const pairLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many pairing attempts, try again later', status: 429 } },
});

// Latest shipped capture client. Bump minSupported when a change makes older
// clients wrong rather than merely outdated — a qni control-id change, say,
// where an old client silently captures nothing and the user assumes the tool
// is broken.
// v2 reworded the UI, v3 added the optional `side` field, v4 scans more often
// and sends a heartbeat, v5 starts its sweep from onCreate, v6 finds the
// candidate lists by id instead of walking the tree, v8 ties the client's
// "already sent" set to the token instead of the process, and v9 reports each
// title's row in the candidate list so the panel can line the two teams up the
// way qni does.
//
// v8 is the only release where an older client is actually wrong rather than
// merely limited: up to v7 that set was never cleared, so after switching
// playlists or re-pairing, every title captured under the previous token was
// skipped and the song silently never appeared. minSupported stays at 1 anyway
// — an old client still captures everything on a fresh pairing, and cutting
// users off mid-round is worse than the bug. The upgrade prompt covers it.
// A pre-v9 client simply sends no row and the panel falls back to independent
// columns.
// v10 only sends a row for titles actually inside a candidate list: screens
// without one returned 0 from getRowIndex() rather than -1, so nine unrelated
// titles claimed row 0 and the panel showed one of them. The panel no longer
// lets a repeated row overwrite anything either, so a v9 client is cosmetically
// off at worst.
const CLIENT_VERSION = {
  latest: 10,
  minSupported: 1,
  url: 'https://qnicheatsheet.com/qni-capture.apk',
  // Shown on the tools page. Update both when shipping a build, so the page
  // cannot advertise a version the server does not actually serve.
  latestName: '1.9',
  releasedAt: '2026-08-10',
};

// GET /api/capture/version — checked by the client at startup.
router.get('/version', (req, res) => res.json(CLIENT_VERSION));

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
      await captureService.touchSession(req.captureSession);
      return res.json({ outcome: 'no_target' });
    }

    const result = target === 'live'
      ? await captureService.ingestLive({
        session: req.captureSession,
        rawText: req.body && req.body.text,
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
    const result = await captureService.touchSession(req.captureSession);
    // How the client learns which screens to scan. Carried on the heartbeat
    // rather than pushed, because the client already polls this and a second
    // channel would be one more thing to keep alive (item 13). Clients that
    // predate live mode ignore the extra field.
    res.json({
      ...result,
      mode: req.captureSession.mode,
      // What the client actually needs: which screens are worth scanning, and
      // whether to scan at all. Older clients ignore both fields.
      target: req.captureSession.target,
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

    // 唱卡 is admin-only while it is being proven out. The add-on above was
    // sold for auto-tagging, and its holders run a client that does not read
    // the 唱卡 screens -- letting them start a live run would give them a
    // session that can never receive anything. Hiding the page is not enough:
    // this route is reachable directly.
    if (mode === 'live' && req.user.role !== 'ADMIN') {
      return res.status(403).json({
        error: { code: 'NOT_AVAILABLE', message: '唱卡还在内测中，暂未开放' },
      });
    }
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

// PATCH /api/capture/target — point the open connection somewhere, or nowhere.
router.patch('/target', ...web, requireCaptureAddOn, async (req, res, next) => {
  try {
    const { target, playlistId } = req.body || {};

    // 唱卡 stays admin-only while it is proven out, same as the session route.
    if (target === 'live' && req.user.role !== 'ADMIN') {
      return res.status(403).json({
        error: { code: 'NOT_AVAILABLE', message: '唱卡还在内测中，暂未开放' },
      });
    }

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

module.exports = router;
