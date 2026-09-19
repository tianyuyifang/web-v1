const path = require('path');
const { PrismaClient } = require('@prisma/client');

// Background maintenance scripts run as their own short-lived processes, each
// with its own connection pool. On a small (2-core) box, a script's default
// pool of 20 lets it fire 20 concurrent queries and saturate the DB CPU, which
// starves the live web server's queries and surfaces to users as P2024 pool
// timeouts + nginx 504s. The web server itself is the ONE process launched from
// src/server.js; everything under scripts/ is background work. So scripts get a
// tiny pool (2) and can never crowd out the site, while the server keeps the
// full pool from DATABASE_URL untouched.
//
// The entry file decides which we are — the server is always `node src/server.js`,
// scripts are always `node scripts/<name>.js`. This keeps the change in one
// place instead of editing ~40 script requires (and never missing one).
function isBackgroundScript() {
  const entry = process.argv[1] || '';
  const parts = entry.split(/[\\/]/);
  // True only when the entry file sits inside a `scripts` directory.
  const dir = parts.slice(0, -1);
  return dir.includes('scripts');
}

// Give a background script a 2-connection pool without touching the shared
// DATABASE_URL (so the web server's pool is unaffected). datasourceUrl is a
// whole-string override supported since Prisma 5.2 (we run 5.22). We only
// rewrite connection_limit; the password's %40 encoding and every other param
// are preserved verbatim.
function backgroundUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  const [base, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  params.set('connection_limit', '2');
  return `${base}?${params.toString()}`;
}

const prisma = isBackgroundScript()
  ? new PrismaClient({ datasourceUrl: backgroundUrl() })
  : new PrismaClient();

module.exports = prisma;
