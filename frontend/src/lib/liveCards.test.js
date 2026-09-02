// Unit test for the 唱卡 card filter (pure helpers).
// Run: node src/lib/liveCards.test.js
// No test framework in the frontend — plain Node assertions, like the backend tests.

const { isCardWorthShowing, keepShowableCards } = require("./liveCards");

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name}`); }
}

const mapping = { mappingId: "m1", source: "QQ", externalId: "x1" };

// ---------------------------------------------------------------------------
console.log("Test: the four shapes a card can take");
{
  // The target: a half-read row. No artist, and nothing to play.
  check("artistless and unmapped is dropped",
    isCardWorthShowing({ title: "小情歌", artist: "", mapping: null }) === false);

  // A genuine unmapped capture. The game named the artist, so this is a real
  // gap in the catalogue and the reviewer needs to see it.
  check("unmapped but named keeps its place",
    isCardWorthShowing({ title: "小情歌", artist: "苏打绿", mapping: null }) === true);

  // Playable without an artist — nothing to gain by hiding it.
  check("mapped without an artist is kept",
    isCardWorthShowing({ title: "小情歌", artist: "", mapping }) === true);

  check("an ordinary card is kept",
    isCardWorthShowing({ title: "小情歌", artist: "苏打绿", mapping }) === true);
}

// ---------------------------------------------------------------------------
console.log("\nTest: artist field edge cases");
{
  check("whitespace is not an artist",
    isCardWorthShowing({ artist: "   ", mapping: null }) === false);
  check("undefined artist behaves as absent",
    isCardWorthShowing({ mapping: null }) === false);
  check("null card is dropped rather than thrown on",
    isCardWorthShowing(null) === false);
  check("a non-string artist still counts when present",
    isCardWorthShowing({ artist: 0, mapping }) === true);
}

// ---------------------------------------------------------------------------
console.log("\nTest: filtering a list preserves order and drops only the target");
{
  const cards = [
    { eventId: "a", artist: "苏打绿", mapping },
    { eventId: "b", artist: "", mapping: null },       // dropped
    { eventId: "c", artist: "陈奕迅", mapping: null },
    { eventId: "d", artist: "", mapping },
  ];
  const kept = keepShowableCards(cards).map((c) => c.eventId);
  check("only the artistless-and-unmapped card goes", kept.join(",") === "a,c,d");
  check("a non-array is handled", keepShowableCards(undefined).length === 0);
}

// ---------------------------------------------------------------------------
// The reason this filter exists: rounds are grouped by arrival gap and only the
// newest stays open, so a lone half-read card landing between two rounds opens
// a round of its own and folds the one the singer was reading.
console.log("\nTest: a dropped card no longer splits a round in two");
{
  const ROUND_IDLE_MS = 60 * 1000;
  // Same grouping rule as the page: newest first, compared against the nearest
  // card already in the round.
  function toBatches(cards) {
    const sorted = [...cards].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const batches = [];
    for (const card of sorted) {
      const at = new Date(card.createdAt).getTime();
      const last = batches[batches.length - 1];
      if (last && last.oldest - at < ROUND_IDLE_MS) {
        last.cards.push(card);
        last.oldest = at;
      } else {
        batches.push({ at: card.createdAt, oldest: at, cards: [card] });
      }
    }
    return batches;
  }

  const t = (s) => new Date(Date.UTC(2026, 8, 2, 12, 0, s)).toISOString();
  // A round, then a lone half-read card 90s later, then the next round 90s on:
  // the shape measured in production (gaps of 61-168s before, 33-116s after).
  const withNoise = [
    { eventId: "r1a", artist: "苏打绿", mapping, createdAt: t(0) },
    { eventId: "r1b", artist: "薛之谦", mapping, createdAt: t(0) },
    { eventId: "junk", artist: "", mapping: null, createdAt: t(90) },
    { eventId: "r2a", artist: "陈奕迅", mapping, createdAt: t(180) },
    { eventId: "r2b", artist: "王菲", mapping, createdAt: t(180) },
  ];

  check("unfiltered, the stray card makes a third round", toBatches(withNoise).length === 3);
  check("unfiltered, that round holds nothing but the stray card",
    toBatches(withNoise).some((b) => b.cards.length === 1 && b.cards[0].eventId === "junk"));

  const cleaned = toBatches(keepShowableCards(withNoise));
  check("filtered, the two real rounds stand alone", cleaned.length === 2);
  check("filtered, both real rounds keep every card",
    cleaned.every((b) => b.cards.length === 2));
  check("filtered, the newest round is a real one (so it is the one left open)",
    cleaned[0].cards[0].eventId.startsWith("r2"));
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
