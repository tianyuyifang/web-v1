// Unit test for findAdjacentUnliked (pure helper).
// Run: node src/lib/clipNav.test.js
// No test framework in the frontend — plain Node assertions, like the backend tests.

const { findAdjacentUnliked } = require("./clipNav");

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

const PL = "pl1";
// Helper to build a clip list with given clipIds
const clips = (...ids) => ids.map((id) => (id == null ? null : { clipId: id }));
// Helper to build a likedClips Set from clipIds
const liked = (...ids) => new Set(ids.map((id) => `${PL}:${id}`));

// ---------------------------------------------------------------------------
console.log("Test: forward finds the next unliked clip (skipping liked)");
{
  const all = clips("a", "b", "c", "d");
  // from index 0 (a), b liked, c unliked -> expect index 2
  const idx = findAdjacentUnliked(all, 0, 1, liked("b"), PL);
  check("returns 2 (skips liked b, lands on c)", idx === 2);
}

console.log("Test: backward finds the previous unliked clip (skipping liked)");
{
  const all = clips("a", "b", "c", "d");
  // from index 3 (d), c liked, b unliked -> expect index 1
  const idx = findAdjacentUnliked(all, 3, -1, liked("c"), PL);
  check("returns 1 (skips liked c, lands on b)", idx === 1);
}

console.log("Test: forward edge returns -1");
{
  const all = clips("a", "b", "c");
  const idx = findAdjacentUnliked(all, 2, 1, liked(), PL);
  check("from last index forward -> -1", idx === -1);
}

console.log("Test: backward edge returns -1");
{
  const all = clips("a", "b", "c");
  const idx = findAdjacentUnliked(all, 0, -1, liked(), PL);
  check("from first index backward -> -1", idx === -1);
}

console.log("Test: all other clips liked returns -1");
{
  const all = clips("a", "b", "c", "d");
  const idx = findAdjacentUnliked(all, 0, 1, liked("b", "c", "d"), PL);
  check("everything ahead liked -> -1", idx === -1);
}

console.log("Test: skips null/hole entries");
{
  const all = clips("a", null, "c"); // index 1 is a hole
  const idx = findAdjacentUnliked(all, 0, 1, liked(), PL);
  check("forward skips hole, lands on c (index 2)", idx === 2);
}

console.log("Test: single-clip playlist returns -1 both directions");
{
  const all = clips("a");
  check("forward -> -1", findAdjacentUnliked(all, 0, 1, liked(), PL) === -1);
  check("backward -> -1", findAdjacentUnliked(all, 0, -1, liked(), PL) === -1);
}

console.log("Test: reference clip is excluded even if unliked");
{
  const all = clips("a", "b");
  // from index 0; a is unliked but must not be returned; b unliked -> index 1
  const idx = findAdjacentUnliked(all, 0, 1, liked(), PL);
  check("does not return the reference index", idx === 1);
}

console.log("Test: liked basis is per-playlist (key includes playlistId)");
{
  const all = clips("a", "b");
  // 'b' liked under a DIFFERENT playlist should NOT count as liked here
  const otherPlaylistLikes = new Set(["other:b"]);
  const idx = findAdjacentUnliked(all, 0, 1, otherPlaylistLikes, PL);
  check("b not treated as liked (different playlist) -> index 1", idx === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
