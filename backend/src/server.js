const express = require('express');
const cors = require('cors');
const compression = require('compression');
const config = require('./config');
const prisma = require('./db/client');
const errorHandler = require('./middleware/errorHandler');
const {
  authMiddleware, requireRole, requireApproved, requireActiveSession, requireMappingEditor,
} = require('./middleware/auth');
const trackBandwidth = require('./middleware/bandwidth');

const app = express();

// Trust the first proxy (Nginx) so req.ip reflects the real client IP.
// Required for rate limiting to work per-user instead of per-server.
app.set('trust proxy', 1);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Global middleware
// Compression on all routes except SSE. The compression middleware wraps
// res.write even when filtering, which can interfere with SSE streaming.
// Skipping entirely for SSE keeps res.write raw and unbuffered.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/sse')) return next();
  compression()(req, res, next);
});
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json());

// Public routes (no auth required)
// Rate limiting is applied per-endpoint inside auth.js (only on login + register)
app.use('/api/auth', require('./routes/auth'));

// Protected routes (auth + approved members + active session)
app.use('/api/songs',     authMiddleware, requireApproved, requireActiveSession, require('./routes/songs'));
app.use('/api/clips',     authMiddleware, requireApproved, requireActiveSession, require('./routes/clips'));
app.use('/api/playlists', authMiddleware, requireApproved, requireActiveSession, require('./routes/playlists'));
app.use('/api/likes',     authMiddleware, requireApproved, requireActiveSession, require('./routes/likes'));
app.use('/api/stream',    authMiddleware, requireApproved, requireActiveSession, trackBandwidth, require('./routes/stream'));
app.use('/api/sse',       authMiddleware, requireApproved, require('./routes/sse')); // no requireActiveSession — SSE is read-only
app.use('/api/users',     authMiddleware, requireApproved, requireActiveSession, require('./routes/users'));

// Capture routes — auth is per-route inside: JWT for management, capture token
// for ingest. Deliberately NOT requireActiveSession at the mount: a capture
// client must not consume a device slot and evict the user's browser login.
app.use('/api/capture', require('./routes/capture'));

// Feedback routes (submit = approved users, list/delete = admin)
app.use('/api/feedback', authMiddleware, requireApproved, requireActiveSession, require('./routes/feedback'));

// Updates routes (read = approved users, create/edit/delete = admin)
app.use('/api/updates', authMiddleware, requireApproved, requireActiveSession, require('./routes/updates'));

// A user's own QQ / NetEase credentials. Every route acts on the caller's own
// account; none of them ever returns a stored cookie.
app.use('/api/music-sources', authMiddleware, requireApproved, requireActiveSession, require('./routes/musicSources'));

// Song-mapping review. A mapping decides what plays for everyone, so this is
// limited to admins and the few users given the canEditMapping flag.
app.use('/api/mappings', authMiddleware, requireApproved, requireActiveSession, requireMappingEditor, require('./routes/mappings'));

// Admin routes (auth + ADMIN role only)
app.use('/api/admin', authMiddleware, requireRole('ADMIN'), requireActiveSession, require('./routes/admin'));

// Error handling
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});
