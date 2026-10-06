/**
 * POST /api/csp-report — browsers report what the Content-Security-Policy
 * would have blocked (services/cspReports). No auth: a browser sends these
 * on its own, without the page's token. Limited per address, small bodies,
 * and nothing in them is ever acted on -- only counted.
 */
const router = require('express').Router();
const express = require('express');
const rateLimit = require('express-rate-limit');
const cspReports = require('../services/cspReports');

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: false,
  legacyHeaders: false,
  // Over the limit: dropped quietly (a browser does not retry reports).
  handler: (req, res) => res.status(204).end(),
});

// The two content types browsers use: report-uri sends application/csp-report,
// report-to sends application/reports+json.
const parse = express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '64kb' });

// A body that is not JSON is dropped quietly too, not logged as an error.
const parseQuietly = (req, res, next) => parse(req, res, (err) => (err ? res.status(204).end() : next()));

router.post('/', limiter, parseQuietly, (req, res) => {
  try {
    cspReports.ingest(req.body);
  } catch {
    /* a malformed report is not worth an error */
  }
  res.status(204).end();
});

module.exports = router;
