/**
 * match-chorus.js — DRY RUN matcher for chorus_points batch clip creation.
 * Reads chorus.b64.txt (base64 of JSON array), resolves each row to a song
 * in the DB, and reports match quality. Makes NO writes.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/db/client');

const rows = JSON.parse(
  Buffer.from(fs.readFileSync(path.join(__dirname, 'chorus.b64.txt'), 'ascii'), 'base64').toString('utf8')
);

const norm = (s) => (s == null ? '' : String(s).normalize('NFC').trim().toLowerCase());
// artists are stored underscore-separated; compare as a set
const artistKey = (s) => norm(s).split(/[_&,/]+/).map((x) => x.trim()).filter(Boolean).sort().join('|');

(async () => {
  const songs = await prisma.song.findMany({
    select: { id: true, title: true, artist: true, filePath: true, duration: true, starts: true },
  });

  const byFilePath = new Map();
  const byTitleArtist = new Map();
  const byTitle = new Map();
  for (const s of songs) {
    byFilePath.set(norm(s.filePath), s);
    const ta = norm(s.title) + '||' + artistKey(s.artist);
    if (!byTitleArtist.has(ta)) byTitleArtist.set(ta, []);
    byTitleArtist.get(ta).push(s);
    const t = norm(s.title);
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(s);
  }

  const results = [];
  for (const r of rows) {
    let song = null;
    let how = null;

    const fp = byFilePath.get(norm(r.file_path));
    if (fp) { song = fp; how = 'file_path'; }

    if (!song) {
      const cand = byTitleArtist.get(norm(r.title) + '||' + artistKey(r.artist)) || [];
      if (cand.length === 1) { song = cand[0]; how = 'title+artist'; }
      else if (cand.length > 1) { how = 'AMBIGUOUS title+artist x' + cand.length; }
    }

    if (!song && !how) {
      const cand = byTitle.get(norm(r.title)) || [];
      if (cand.length === 1) { song = cand[0]; how = 'title-only(artist differs: db=' + cand[0].artist + ')'; }
      else if (cand.length > 1) { how = 'AMBIGUOUS title x' + cand.length; }
      else { how = 'NO MATCH'; }
    }

    results.push({ r, song, how });
  }

  const matched = results.filter((x) => x.song);
  const unmatched = results.filter((x) => !x.song);

  console.log('=== SUMMARY ===');
  console.log('rows:', rows.length, 'matched:', matched.length, 'unmatched:', unmatched.length);
  const byHow = {};
  for (const x of results) {
    const k = x.song ? x.how.split('(')[0] : x.how.split(' x')[0];
    byHow[k] = (byHow[k] || 0) + 1;
  }
  console.log('match method:', JSON.stringify(byHow));

  // Clip-level analysis for matched songs
  const LENGTH = 20;
  let toCreate = 0, alreadyExist = 0, pastDuration = 0, missingMp3 = 0, noPoint = 0;
  const MP3_BASE = process.env.MP3_BASE_PATH || '/var/www/music/allSongs';
  const detail = [];
  for (const { r, song } of matched) {
    const existing = new Set(
      (await prisma.clip.findMany({ where: { songId: song.id }, select: { start: true } })).map((c) => c.start)
    );
    // floor only — chorus_sec_ceil is ignored by design.
    const starts = [r.f].filter((v) => Number.isInteger(v) && v >= 0);
    if (!starts.length) { noPoint++; continue; }
    const mp3ok = fs.existsSync(path.join(MP3_BASE, song.filePath));
    if (!mp3ok) missingMp3++;
    for (const st of starts) {
      if (song.duration && st >= song.duration) { pastDuration++; continue; }
      if (existing.has(st)) { alreadyExist++; continue; }
      toCreate++;
    }
    detail.push({ title: song.title, artist: song.artist, starts, mp3ok, dur: song.duration });
  }

  console.log('\n=== CLIP PLAN (length=' + LENGTH + 's) ===');
  console.log('clips to create:', toCreate);
  console.log('already exist (skip):', alreadyExist);
  console.log('no chorus point — blank cell (skip):', noPoint);
  console.log('start >= duration (skip):', pastDuration);
  console.log('songs w/ MISSING mp3 file:', missingMp3);

  if (unmatched.length) {
    console.log('\n=== UNMATCHED ROWS ===');
    for (const x of unmatched) {
      console.log(JSON.stringify({ title: x.r.title, artist: x.r.artist, file_path: x.r.file_path, why: x.how }));
    }
  }

  const loose = matched.filter((x) => x.how.startsWith('title-only'));
  if (loose.length) {
    console.log('\n=== TITLE-ONLY MATCHES (artist mismatch — review) ===');
    for (const x of loose) {
      console.log(JSON.stringify({ xlsx: x.r.title + ' / ' + x.r.artist, db: x.song.title + ' / ' + x.song.artist }));
    }
  }

  const nomp3 = detail.filter((d) => !d.mp3ok);
  if (nomp3.length) {
    console.log('\n=== MATCHED BUT MP3 FILE MISSING ===');
    for (const d of nomp3) console.log(JSON.stringify(d));
  }

  await prisma.$disconnect();
})();
