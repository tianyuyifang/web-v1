const router = require('express').Router();
const captureService = require('../services/captureService');
const { authMiddleware, requireApproved, requireActiveSession } = require('../middleware/auth');
const captureAuth = require('../middleware/captureAuth');

// --- capture-token authenticated (the capture client) ---

// POST /api/capture/ingest — submit one captured title
// Auth is the capture token, NOT the login JWT, and requireActiveSession is
// deliberately absent: it would consume a device slot and evict the browser.
router.post('/ingest', captureAuth, async (req, res, next) => {
  try {
    const result = await captureService.ingestText({
      session: req.captureSession,
      rawText: req.body && req.body.text,
    });
    res.json(result);
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
