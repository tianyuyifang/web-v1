require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 4000,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  defaultDeviceLimit: parseInt(process.env.DEFAULT_DEVICE_LIMIT, 10) || 1,
  mp3BasePath: process.env.MP3_BASE_PATH,
  clipsBasePath: process.env.CLIPS_BASE_PATH,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL,
};
