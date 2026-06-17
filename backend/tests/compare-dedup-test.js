// Unit test for compareSongLists — focuses on external-side deduplication.
// Run: node tests/compare-dedup-test.js
// A duplicate = same title (trimmed, case-sensitive) AND same artist (trimmed, case-sensitive).

const { compareSongLists } = require('../src/routes/playlists');

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Test 1: duplicates removed from each external-facing category
// ---------------------------------------------------------------------------
console.log('Test 1: external duplicates removed from missing / titleMatch / artistMismatch');
{
  const local = [
    { title: 'Matched Song', artist: 'Jay' },        // for titleMatch
    { title: 'Mismatch Song', artist: 'Alice' },     // for artistMismatch (local artist differs)
    { title: 'Local Exclusive', artist: 'Bob' },     // for localOnly
  ];
  const external = [
    // titleMatch: title + overlapping artist; listed TWICE
    { title: 'Matched Song', artist: 'Jay' },
    { title: 'Matched Song', artist: 'Jay' },
    // artistMismatch: same title, non-overlapping artist; listed TWICE
    { title: 'Mismatch Song', artist: 'Carol' },
    { title: 'Mismatch Song', artist: 'Carol' },
    // missing: not in local at all; listed TWICE
    { title: 'Ghost Song', artist: 'Dave' },
    { title: 'Ghost Song', artist: 'Dave' },
  ];

  const r = compareSongLists(local, external);

  check('titleMatch has 1 entry (dup removed)', r.titleMatch.length === 1);
  check('artistMismatch has 1 entry (dup removed)', r.artistMismatch.length === 1);
  check('missing has 1 entry (dup removed)', r.missing.length === 1);
  check('externalTotal == 3 (deduped count)', r.externalTotal === 3);
  check('counts add up: missing+titleMatch+artistMismatch == externalTotal',
    r.missing.length + r.titleMatch.length + r.artistMismatch.length === r.externalTotal);
  check('localOnly has 1 entry (Local Exclusive)',
    r.localOnly.length === 1 && r.localOnly[0].title === 'Local Exclusive');
  check('localTotal == 3', r.localTotal === 3);
}

// ---------------------------------------------------------------------------
// Test 2: same title but DIFFERENT artist is NOT a duplicate (both kept)
// ---------------------------------------------------------------------------
console.log('Test 2: same title + different artist are both kept (not duplicates)');
{
  const local = [];
  const external = [
    { title: 'Cover Song', artist: 'Original' },
    { title: 'Cover Song', artist: 'CoverBand' }, // same title, different artist
  ];
  const r = compareSongLists(local, external);
  check('both kept in missing (2 entries)', r.missing.length === 2);
  check('externalTotal == 2', r.externalTotal === 2);
}

// ---------------------------------------------------------------------------
// Test 3: dedup key respects trim() and case-sensitivity
// ---------------------------------------------------------------------------
console.log('Test 3: trim collapses whitespace dups; case difference is NOT a dup');
{
  const local = [];
  const external = [
    { title: 'Song A', artist: 'X' },
    { title: '  Song A  ', artist: '  X  ' }, // same after trim -> duplicate
    { title: 'song a', artist: 'X' },          // different case -> NOT a duplicate
  ];
  const r = compareSongLists(local, external);
  check('whitespace-only difference deduped, case kept -> 2 missing', r.missing.length === 2);
  check('externalTotal == 2', r.externalTotal === 2);
}

// ---------------------------------------------------------------------------
// Test 4: no duplicates -> behavior unchanged
// ---------------------------------------------------------------------------
console.log('Test 4: no external duplicates leaves results intact');
{
  const local = [{ title: 'A', artist: 'Jay' }];
  const external = [
    { title: 'A', artist: 'Jay' }, // titleMatch
    { title: 'B', artist: 'Z' },   // missing
  ];
  const r = compareSongLists(local, external);
  check('titleMatch 1', r.titleMatch.length === 1);
  check('missing 1', r.missing.length === 1);
  check('externalTotal 2', r.externalTotal === 2);
  check('localOnly 0', r.localOnly.length === 0);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
