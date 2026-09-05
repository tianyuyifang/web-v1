/* Read-only: dump the tracks that still need a chorus point. No writes. */
const prisma = require('../src/db/client');
const fs = require('fs');

(async () => {
  // The column may not exist yet (migration not deployed), so ask rather than
  // assume: with it, resume where a previous run stopped; without it, take all.
  const cols = await prisma.$queryRawUnsafe(
    "SELECT column_name FROM information_schema.columns"
    + " WHERE table_name='imported_tracks' AND column_name='chorus_ms'"
  );
  const hasCol = cols.length > 0;

  const sql = hasCol
    ? "SELECT source, external_id, title, artist FROM imported_tracks"
      + " WHERE source IN ('QQ','NETEASE') AND chorus_fetched_at IS NULL"
      + " ORDER BY source, created_at"
    : "SELECT source, external_id, title, artist FROM imported_tracks"
      + " WHERE source IN ('QQ','NETEASE')"
      + " ORDER BY source, created_at";

  const rows = await prisma.$queryRawUnsafe(sql);
  fs.writeFileSync('/tmp/need-chorus.json', JSON.stringify(rows), 'utf8');
  const qq = rows.filter((r) => r.source === 'QQ').length;
  const ne = rows.filter((r) => r.source === 'NETEASE').length;
  console.log('chorus_ms column exists: ' + hasCol);
  console.log('need chorus: ' + rows.length + ' (QQ ' + qq + ' / NETEASE ' + ne + ')');
  await prisma.$disconnect();
})().catch(async (e) => { console.error('ERR ' + e.message); try { await prisma.$disconnect(); } catch {} process.exit(1); });
