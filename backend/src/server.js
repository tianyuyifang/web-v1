const express = require('express');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const prisma = require('./db/client');
const errorHandler = require('./middleware/errorHandler');
const { authMiddleware, requireRole, requireApproved, requireActiveSession } = require('./middleware/auth');
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
app.use(compression());
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json());

// Rate limiting on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, please try again later' } },
});

// Public routes (no auth required)
app.use('/api/auth', authLimiter, require('./routes/auth'));

// Protected routes (auth + approved members + active session)
app.use('/api/songs',     authMiddleware, requireApproved, requireActiveSession, require('./routes/songs'));
app.use('/api/clips',     authMiddleware, requireApproved, requireActiveSession, require('./routes/clips'));
app.use('/api/playlists', authMiddleware, requireApproved, requireActiveSession, require('./routes/playlists'));
app.use('/api/likes',     authMiddleware, requireApproved, requireActiveSession, require('./routes/likes'));
app.use('/api/stream',    authMiddleware, requireApproved, requireActiveSession, trackBandwidth, require('./routes/stream'));
app.use('/api/sse',       authMiddleware, requireApproved, requireActiveSession, require('./routes/sse'));
app.use('/api/users',     authMiddleware, requireApproved, requireActiveSession, require('./routes/users'));

// Feedback routes (submit = approved users, list/delete = admin)
app.use('/api/feedback', authMiddleware, requireApproved, requireActiveSession, require('./routes/feedback'));

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
