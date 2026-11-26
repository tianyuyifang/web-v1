/**
 * Fixed size limits (not the per-account usage limits — those are in
 * services/rateGuard.js and editable from the admin page).
 *
 * The largest playlist any member had on 2026-11-26 held 671 clips, the
 * largest admin one 679. 1000 is room for all of them and stops one playlist
 * being used as a container for the whole library.
 */
module.exports = {
  MAX_PLAYLIST_CLIPS: 1000,
  MAX_IMPORT_ROWS: 1000,
  PLAYLIST_FULL_MESSAGE: '歌单最多 1000 首',
};
