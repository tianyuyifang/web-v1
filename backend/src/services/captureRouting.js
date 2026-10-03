/**
 * Which round a captured title belongs to, and what the client is told about
 * where captures are going.
 *
 * The client decides which screens to read from the target it last heard, and
 * the server files each title under the target the session holds *now*. For
 * the seconds between the user switching rounds on the site and the client
 * hearing about it, the two disagree -- and a title read for the old round was
 * filed under the new one: 歌 P's 《title》 rows turned up on 唱卡 as
 * artistless cards, and 唱卡's "title-artist" reached a playlist, where an
 * exact match is liked without asking.
 *
 * Measured on production (2026-10-01) before writing this:
 *   playlist captures  77,414 -- 77,409 start with 《; the other 5 are all
 *                                "title-artist", i.e. 唱卡 titles filed there
 *   唱卡 captures     189,596 -- not one contains 《
 *   QQ打标 captures        620 -- every one starts with 《
 * So the shape alone tells the two rounds apart, with nothing real on the wrong
 * side of the line. Clients from v28 also say which view a title came from
 * (`from`), which is checked as well.
 */

const BOOK_TITLE_OPEN = '《';

/**
 * True when this title was read for a different round than the one the
 * session is aimed at, and so must not be filed under it.
 *
 * @param target the session's current target
 * @param from   'gep' | 'live' from clients that report it, else null
 * @param text   the captured title, trimmed
 */
function misrouted({ target, from, text }) {
  const t = String(text || '');
  const gepRound = target === 'playlist' || target === 'platform';
  if (target !== 'live' && !gepRound) return false;
  // A client that names the view is believed: it read the title there. The
  // shape test is only for clients that do not say.
  if (from) return target === 'live' ? from === 'gep' : from === 'live';
  if (target === 'live') return t.includes(BOOK_TITLE_OPEN);
  return !t.startsWith(BOOK_TITLE_OPEN) && t.includes('-');
}

/** 'gep' | 'live' | null -- anything else is treated as not reported. */
function cleanFrom(raw) {
  return raw === 'gep' || raw === 'live' ? raw : null;
}

/**
 * Where captures are going, in the words the client understands.
 *
 * `target` / `playlistId` are exactly what the heartbeat has always answered:
 * a platform run is reported as an ordinary playlist run (the client scans the
 * 歌 P screens for anything that is not live), with the platform ref standing
 * in for the playlist id so a change of list still reads as a change.
 *
 * `realTarget` / `platform` are new and ignored by older clients; they let a
 * client that knows about QQ打标 tell it apart from a playlist run.
 */
function clientTarget(session) {
  const platformRun = session.target === 'platform';
  return {
    target: platformRun ? 'playlist' : session.target,
    playlistId: session.target === 'playlist'
      ? session.playlistId
      : (platformRun ? session.platformRef : null),
    realTarget: session.target,
    platform: platformRun && session.platformRef
      ? String(session.platformRef).split(':')[0]
      : null,
  };
}

module.exports = { misrouted, cleanFrom, clientTarget, BOOK_TITLE_OPEN };
