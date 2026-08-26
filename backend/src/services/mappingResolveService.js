/**
 * The lookup chain: game song -> something playable.
 *
 * ```
 * 1. mapping, approved     play it, no questions asked
 * 2. mapping, unapproved   playable, but a reviewer still has to sign it off
 * 3. imported pool         a track nobody has claimed yet — claim it here
 * 4. external search       NOT DONE HERE (see below)
 * ```
 *
 * Only the last step would call a platform, and it is deliberately absent.
 * Resolving one title per capture would mean an outbound request for every
 * song the game shows, including the four in a round nobody sings — the
 * batch-prefetch shape that got this server's IP throttled twice during
 * development. The pool holds thousands of imported tracks, so step 3 answers
 * most of what step 4 would have, at zero risk.
 *
 * Steps 1 and 2 are the reason this stays cheap: an approved mapping is frozen
 * forever, so a song resolves once by search and never again.
 */
const prisma = require('../db/client');
const { titleKey, artistKey, artistsOverlap, isSeparatorAmbiguous } = require('./songKeyService');

/**
 * How sure we are that an imported track is this game song.
 *
 * `strong` is the only tier that approves itself. The others are playable
 * immediately — waiting for a human mid-game would defeat the point — but they
 * queue for review, and until reviewed they stay changeable.
 */
const TIER = {
  STRONG: 'strong',
  MEDIUM: 'medium',
  WEAK: 'weak',
};

/** Same-title tracks to consider. Well past any real count of versions. */
const MAX_POOL_CANDIDATES = 25;

/**
 * Rank pool tracks against what the game said.
 *
 * Sorted rather than filtered: the game and the platforms disagree about
 * artists constantly (the game says 凤凰传奇 where QQ says 玲花/曾毅), so
 * dropping the rows that fail to overlap would routinely discard the right
 * answer. The reviewer sees the alternatives either way.
 */
function rankCandidates(tracks, rawArtist) {
  return tracks
    .map((t) => ({
      source: t.source,
      externalId: t.externalId,
      title: t.title,
      artist: t.artist,
      durationSec: t.durationSec,
      album: t.album,
      vipOnly: t.vipOnly,
      artistMatches: artistsOverlap(rawArtist, t.artist),
    }))
    .sort((a, b) => Number(b.artistMatches) - Number(a.artistMatches));
}

/**
 * Which tier a pool match belongs to.
 *
 * The separator check exists because `/`, `&` and `_` all occur inside real
 * names — AC/DC, Simon & Garfunkel — so splitting on them is a guess, and a
 * guess should not approve itself.
 *
 * But it only matters while the guess is load-bearing. Both sides of the
 * comparison run through the same splitArtists(), so a wrong split is applied
 * identically to each: `AC/DC` read as two artists is read as the same two
 * artists on the platform side, the keys still agree, and the mapping still
 * names the right recording. Once the two keys are byte-equal, whether the
 * split was right has stopped affecting the answer.
 *
 * So exactness is checked first. This was the wrong way round, and it showed:
 * every duet in the catalogue — 周杰伦/费玉清 against 周杰伦/费玉清 — was held
 * for review however exactly it agreed, and 81 of 1,426 mappings had been
 * confirmed by hand for no reason other than carrying one separator.
 *
 * What still reaches the ambiguity check is the case it was written for: a
 * separator string whose two sides do NOT agree, where the split really is
 * deciding the outcome.
 */
function classify({ gameArtist, track, exactArtist, ambiguous }) {
  // Title and artist both agree outright. Nothing left to judge — including,
  // deliberately, whether a separator inside them was split correctly.
  if (exactArtist) return TIER.STRONG;
  if (ambiguous) return TIER.WEAK;
  // Title matches and the artists share at least one name — the usual shape of
  // "same song, different billing".
  if (artistsOverlap(gameArtist, track.artist)) return TIER.MEDIUM;
  // Title alone. Could be a cover, could be the platform naming the artist
  // differently; only listening settles it.
  return TIER.MEDIUM;
}

/**
 * Resolve one game song to something playable, creating a mapping if the pool
 * can answer.
 *
 * Returns `{ status, mapping, tier, candidates }`. `status` is one of:
 *   `approved`   a signed-off mapping (step 1)
 *   `pending`    a mapping that plays but still needs review (steps 2 and 3)
 *   `unmapped`   nothing in the pool matched; step 4 would be next
 *
 * Never throws for "not found" — an unmapped song is the ordinary way a gap in
 * coverage shows up, and it is what the review page exists to fill.
 */
async function resolveGameSong({ title, artist }) {
  const tk = titleKey(title);
  const ak = artistKey(artist);
  if (!tk) return { status: 'unmapped', mapping: null, tier: null, candidates: [] };

  // A 唱卡 capture always names its artist: the picking screen carries it in
  // its own view beside the title, and the singing screen writes "title-artist".
  // So an empty artist means the capture did not come from 唱卡 at all -- 歌 P
  // titles reaching this channel is how it happened before -- and matching on
  // the title alone is actively wrong: 夜夜夜夜 with no artist was paired with
  // 梁静茹 when the game had said 齐秦.
  //
  // Resolved against an existing mapping is still fine; it is creating one from
  // a title alone that is refused.
  const artistless = !ak;

  // --- steps 1 and 2: an existing mapping wins, approved or not ---
  const existing = await prisma.songMapping.findUnique({
    where: { titleKey_artistKey: { titleKey: tk, artistKey: ak } },
  });
  if (existing) {
    return {
      status: existing.approved ? 'approved' : 'pending',
      mapping: existing,
      tier: existing.matchKind || null,
      candidates: [],
    };
  }

  // Nothing on record, and nothing to key a new record on. Answering
  // "unmapped" leaves the pool track where it is, still counted as unseen,
  // so the song is picked up properly the next time the game names its artist.
  if (artistless) {
    return { status: 'unmapped', mapping: null, tier: null, candidates: [] };
  }

  // --- step 3: claim a track from the imported pool ---
  //
  // Queried by title alone on purpose. The artist is part of the mapping key,
  // but the pool stores the PLATFORM's artist, which routinely differs from
  // the game's — so keying the lookup on both would miss the very rows this
  // step exists to find. The artist is applied below, as ranking.
  const pool = await prisma.importedTrack.findMany({
    where: { titleKey: tk },
    take: MAX_POOL_CANDIDATES,
  });
  if (!pool.length) {
    return { status: 'unmapped', mapping: null, tier: null, candidates: [] };
  }

  const ranked = rankCandidates(pool, artist);
  const best = pool.find((t) => t.externalId === ranked[0].externalId) || pool[0];

  // Whether either side carries a separator whose split is a guess. Only
  // consulted when the two artist keys disagree — see classify: a split that
  // both sides made identically cannot have changed the answer.
  const ambiguous = isSeparatorAmbiguous(artist) || isSeparatorAmbiguous(best.artist);
  const exactArtist = Boolean(ak) && artistKey(best.artist) === ak;
  const tier = classify({ gameArtist: artist, track: best, exactArtist, ambiguous });

  // Only an exact agreement on both halves approves itself. Everything else is
  // playable now and judged later — the review queue is the safety net, not a
  // gate in front of the music.
  const approved = tier === TIER.STRONG;

  const mapping = await prisma.songMapping.create({
    data: {
      titleKey: tk,
      artistKey: ak,
      rawTitle: String(title).trim(),
      rawArtist: String(artist || '').trim(),
      source: best.source,
      externalId: best.externalId,
      platformTitle: best.title,
      platformArtist: best.artist,
      durationSec: best.durationSec,
      approved,
      origin: 'import',
      matchKind: tier,
      // The alternatives are kept so review can offer them without going back
      // to the pool, and so a wrong pick is one click from being corrected.
      candidates: ranked.length > 1 ? ranked.slice(0, 8) : undefined,
      ...(approved ? { approvedAt: new Date() } : {}),
      ...(ambiguous ? { note: '歌手名分隔符可疑，需人工确认' } : {}),
    },
  });

  // Mark the pool row as seen in play. This is what turns the review page's
  // "未遇见" count into a coverage meter rather than a static import total.
  await prisma.importedTrack.updateMany({
    where: { source: best.source, externalId: best.externalId, matchedAt: null },
    data: { matchedAt: new Date() },
  });

  return {
    status: approved ? 'approved' : 'pending',
    mapping,
    tier,
    candidates: ranked,
  };
}

module.exports = { resolveGameSong, TIER, rankCandidates, classify };
