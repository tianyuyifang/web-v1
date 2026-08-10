const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const captureService = require('../services/captureService');
const { authMiddleware, requireApproved, requireActiveSession } = require('../middleware/auth');
const captureAuth = require('../middleware/captureAuth');

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
    const result = await captureService.ingestText({
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
    res.json(await captureService.touchSession(req.captureSession));
  } catch (err) {
    next(err);
  }
});

// --- JWT authenticated (the website) ---
const web = [authMiddleware, requireApproved, requireActiveSession];

// POST /api/capture/sessions — start a run; token is shown once
router.post('/sessions', ...web, async (req, res, next) => {
  try {
    const { playlistId, label, ttlMinutes } = req.body || {};
    const { session, token } = await captureService.startSession({
      userId: req.user.id, playlistId, label, ttlMinutes,
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
        label: session.label,
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
