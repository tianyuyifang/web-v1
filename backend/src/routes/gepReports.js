/**
 * 歌P战报 — a member's own reports of their 歌P runs.
 *
 * Mounted behind login (server.js). Every route also needs one of the two
 * add-ons that run 歌P (自动打标 or QQ打标), checked against the database on
 * each request, and every report is read and changed only by its owner (the
 * service checks). Hiding the tab in the page is not the boundary; this is.
 */

const router = require('express').Router();
const prisma = require('../db/client');
const { ADD_ONS, hasAddOn } = require('../utils/entitlements');
const settingsService = require('../services/settingsService');
const reports = require('../services/gepReportService');
const noEtag = require('../middleware/noEtag');

async function requireGepAddOn(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { role: true, entitlements: true, tier: true },
    });
    const tiers = await settingsService.getTiers();
    if (!hasAddOn(user, ADD_ONS.CAPTURE, tiers) && !hasAddOn(user, ADD_ONS.PLATFORM_TAGGING, tiers)) {
      return res.status(403).json({
        error: { code: 'ADD_ON_REQUIRED', message: '歌P战报需要开通自动打标', status: 403 },
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireGepAddOn);

// GET /api/gep-reports — this user's reports from the last 7 days, newest first
router.get('/', noEtag, async (req, res, next) => {
  try {
    res.json(await reports.listReports(req.user.id));
  } catch (err) {
    next(err);
  }
});

// GET /api/gep-reports/latest — the id of the newest one (查看本局战报)
router.get('/latest', noEtag, async (req, res, next) => {
  try {
    res.json({ id: await reports.latestReportId(req.user.id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/gep-reports/:id — one report with its songs in the order seen
router.get('/:id', noEtag, async (req, res, next) => {
  // The connection closing before the answer is sent means the page gave up
  // (nginx times out at 60 s); stop looking songs up for it.
  let gone = false;
  res.on('close', () => { if (!res.writableFinished) gone = true; });
  try {
    res.json(await reports.getReport(req.user.id, req.params.id, () => gone));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/gep-reports/:id — { singer }
router.patch('/:id', async (req, res, next) => {
  try {
    res.json(await reports.setSinger(req.user.id, req.params.id, req.body && req.body.singer));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/gep-reports/:id/items/:itemId — { title } (empty clears it)
router.patch('/:id/items/:itemId', async (req, res, next) => {
  try {
    res.json(await reports.renameItem(req.user.id, req.params.id, req.params.itemId, req.body && req.body.title));
  } catch (err) {
    next(err);
  }
});

// POST /api/gep-reports/:id/add — { playlistId, picks: [{ itemId, songId }] }
router.post('/:id/add', async (req, res, next) => {
  try {
    const body = req.body || {};
    res.json(await reports.addToPlaylist(req.user.id, req.params.id, { playlistId: body.playlistId, picks: body.picks }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
