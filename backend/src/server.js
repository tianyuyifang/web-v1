const express = require('express');
const cors = require('cors');
const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const { authMiddleware, requireRole, requireApproved } = require('./middleware/auth');

const app = express();

// Global middleware
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json());

// Public routes (no auth required)
app.use('/api/auth', require('./routes/auth'));

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

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});
