const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const prisma = require('./db/client');
const errorHandler = require('./middleware/errorHandler');
const { authMiddleware, requireRole, requireApproved } = require('./middleware/auth');

const app = express();

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Global middleware
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json());

// Rate limiting on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, please try again later' } },
});

// Public routes (no auth required)
app.use('/api/auth', authLimiter, require('./routes/auth'));

// Protected routes (auth + approved members only)
app.use('/api/songs',     authMiddleware, requireApproved, require('./routes/songs'));
app.use('/api/clips',     authMiddleware, requireApproved, require('./routes/clips'));
app.use('/api/playlists', authMiddleware, requireApproved, require('./routes/playlists'));
app.use('/api/likes',     authMiddleware, requireApproved, require('./routes/likes'));
app.use('/api/stream',    authMiddleware, requireApproved, require('./routes/stream'));
app.use('/api/users',     authMiddleware, requireApproved, require('./routes/users'));

// Admin routes (auth + ADMIN role only)
app.use('/api/admin', authMiddleware, requireRole('ADMIN'), require('./routes/admin'));

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
