/**
 * Which 唱卡 captures are worth putting on screen.
 *
 * The game's picking list animates in, and a scan landing mid-animation can
 * read a title with its artist view present but still empty. The APK already
 * holds those back while the rest of the screen shows the read was simply
 * early — but when NO row on a screen pairs, it sends them as-is, because a
 * whole screen with nothing paired is a layout its pairing does not
 * understand rather than an animation frame, and a bare title a reviewer can
 * fix beats no title at all.
 *
 * What arrives here, then, is a title with no artist and nothing to play: the
 * server refuses to map an artistless title, having once paired 夜夜夜夜 with
 * 梁静茹 when the game had said 齐秦.
 *
 * Left on screen they do real damage, and not the obvious kind. Cards are
 * grouped into rounds by arrival gap, and only the newest round stays open —
 * so one of these landing in the pause between two rounds opens a round of its
 * own containing nothing but itself, and folds away the round the singer was
 * reading. Measured over 14 days: 19 such captures, 8 of them far enough from
 * their neighbours to do exactly that.
 *
 * Dropping them loses nothing. All 19 had the same song, with its artist,
 * already captured earlier in the same session — and not one was ever followed
 * by a corrected read, which matches what the APK sees: those screens do not
 * recover.
 */

/**
 * Should this card be shown?
 *
 * Both halves are required. Dropping on a missing artist alone would hide a
 * song that plays perfectly well without one; dropping on "nothing to play"
 * alone would hide the genuine unmapped captures, which name their artist and
 * are the raw material for filling gaps in the catalogue.
 *
 * @param {{artist?: string, mapping?: object|null}} card
 * @returns {boolean}
 */
function isCardWorthShowing(card) {
  if (!card) return false;
  const hasArtist = Boolean(card.artist && String(card.artist).trim());
  const hasPlayable = Boolean(card.mapping);
  return hasArtist || hasPlayable;
}

/** The showable cards of a list, in the order given. */
function keepShowableCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.filter(isCardWorthShowing);
}

export { isCardWorthShowing, keepShowableCards };

// Also CommonJS, so the test can run under plain Node without a build step —
// the same arrangement clipNav.js uses.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { isCardWorthShowing, keepShowableCards };
}
