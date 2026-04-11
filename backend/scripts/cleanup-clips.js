/**
 * Backfill + cleanup script for clips:
 * 1. Flip all private clips (isGlobal=false) to global (isGlobal=true)
 * 2. Delete orphaned audio files (on disk but not in DB)
 *
 * Usage: cd backend && node scripts/cleanup-clips.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const prisma = require('../src/db/client');
const config = require('../src/config');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  if (dryRun) console.log('=== DRY RUN — no changes will be made ===\n');

  // --- 1. Flip private clips to global ---
  const privateClips = await prisma.clip.findMany({
    where: { isGlobal: false },
    select: { id: true, songId: true, start: true, userId: true },
  });

  console.log(`Found ${privateClips.length} private clip(s)`);
  if (privateClips.length > 0) {
    if (!dryRun) {
      const result = await prisma.clip.updateMany({
        where: { isGlobal: false },
        data: { isGlobal: true },
      });
      console.log(`  Flipped ${result.count} clip(s) to global`);
    } else {
      for (const c of privateClips) {
        console.log(`  Would flip: clip ${c.id} (song ${c.songId}, start ${c.start}, user ${c.userId})`);
      }
    }
  }

  // --- 2. Delete orphaned audio files ---
  const clipsDir = config.clipsBasePath;
  if (!clipsDir || !fs.existsSync(clipsDir)) {
    console.log(`\nClips directory not found: ${clipsDir} — skipping orphan cleanup`);
    return;
  }

  // Get all filePaths from DB
  const dbClips = await prisma.clip.findMany({
    select: { filePath: true },
  });
  const dbFiles = new Set(dbClips.map((c) => c.filePath).filter(Boolean));

  // List all .mp3 files on disk
  const diskFiles = fs.readdirSync(clipsDir).filter((f) => f.endsWith('.mp3'));
  console.log(`\nDisk: ${diskFiles.length} mp3 files, DB: ${dbFiles.size} clip records with filePath`);

  const orphaned = diskFiles.filter((f) => !dbFiles.has(f));
  console.log(`Orphaned files: ${orphaned.length}`);

  let deletedCount = 0;
  for (const file of orphaned) {
    const mp3Path = path.join(clipsDir, file);
    const lrcPath = mp3Path.replace(/\.mp3$/i, '.lrc');
    if (dryRun) {
      console.log(`  Would delete: ${file}`);
    } else {
      try { fs.unlinkSync(mp3Path); deletedCount++; } catch {}
      try { fs.unlinkSync(lrcPath); } catch {}
    }
  }

  if (!dryRun && orphaned.length > 0) {
    console.log(`  Deleted ${deletedCount} orphaned mp3 file(s) (+ associated .lrc files)`);
  }

  // --- 3. Clean up orphaned likes (clipId not in clips table) ---
  const allClipIds = await prisma.clip.findMany({ select: { id: true } });
  const clipIdSet = new Set(allClipIds.map((c) => c.id));
  const allLikes = await prisma.like.findMany({ select: { id: true, clipId: true } });
  const orphanedLikes = allLikes.filter((l) => !clipIdSet.has(l.clipId));
  console.log(`\nOrphaned likes (clipId not in DB): ${orphanedLikes.length}`);

  if (orphanedLikes.length > 0) {
    if (!dryRun) {
      const result = await prisma.like.deleteMany({
        where: { id: { in: orphanedLikes.map((l) => l.id) } },
      });
      console.log(`  Deleted ${result.count} orphaned like(s)`);
    } else {
      for (const l of orphanedLikes) {
        console.log(`  Would delete like ${l.id} (clipId: ${l.clipId})`);
      }
    }
  }

  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
