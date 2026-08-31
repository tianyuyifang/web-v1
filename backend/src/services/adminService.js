const bcrypt = require('bcryptjs');
const prisma = require('../db/client');
const { NotFoundError, ForbiddenError } = require('../utils/errors');
const { addOneMonth } = require('../utils/billing');

const SALT_ROUNDS = 10;

// Unambiguous alphabet: no 0/O/1/l/I to avoid confusion when relaying the
// temp password out-of-band.
const TEMP_PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TEMP_PW_LENGTH = 12;

function generateTempPassword() {
  const bytes = require('crypto').randomBytes(TEMP_PW_LENGTH);
  let out = '';
  for (let i = 0; i < TEMP_PW_LENGTH; i++) {
    out += TEMP_PW_ALPHABET[bytes[i] % TEMP_PW_ALPHABET.length];
  }
  return out;
}

/**
 * Returns all users ordered by creation date descending.
 * @returns {Promise<Array>}
 */
async function listUsers() {
  const users = await prisma.user.findMany({
    select: {
      id: true, username: true, role: true, createdAt: true,
      expiresAt: true, monthlyFee: true, paymentStatus: true, billingNotes: true,
      deviceLimit: true, demotedAt: true, previousRole: true, entitlements: true,
      _count: { select: { playlists: true, sharedPlaylists: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  // Flatten counts: ownedCount = playlists this user owns; sharedCount = playlists shared WITH them.
  return users.map(({ _count, ...u }) => ({
    ...u,
    ownedCount: _count.playlists,
    sharedCount: _count.sharedPlaylists,
  }));
}

/**
 * Returns only users with role PENDING.
 * @returns {Promise<Array>}
 */
async function listPending() {
  return prisma.user.findMany({
    where: { role: 'PENDING' },
    select: { id: true, username: true, role: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Promotes a user to MEMBER and starts a fresh paid month.
 *
 * The 30 days matter: billing is monthly, and once expiry runs automatically
 * a promotion that left a lapsed date in place would drop the user straight
 * back to PENDING on the next sweep.
 *
 * @param {string} id - User UUID
 * @returns {Promise<object>}
 */
async function approveUser(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');
  if (user.role === 'ADMIN') throw new ForbiddenError('Cannot change admin role');

  // Clearing demotedAt and previousRole matters: this account is current
  // again, so a later demotion should read as new rather than as the old one
  // still standing.
  return prisma.user.update({
    where: { id },
    data: {
      role: 'MEMBER',
      demotedAt: null,
      previousRole: null,
      expiresAt: addOneMonth(new Date()),
    },
    select: { id: true, username: true, role: true },
  });
}

/**
 * Moves a user to GUEST — the limited tier — from either direction: an admin
 * stepping a member down without locking them out, or letting someone in from
 * PENDING on a short leash.
 * @param {string} id - User UUID
 * @returns {Promise<object>}
 */
async function makeGuest(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');
  if (user.role === 'ADMIN') throw new ForbiddenError('Cannot change admin role');

  return prisma.user.update({
    where: { id },
    data: { role: 'GUEST', demotedAt: null, previousRole: null },
    select: { id: true, username: true, role: true },
  });
}

/**
 * Demotes a GUEST or MEMBER to PENDING, which cannot log in. Records both when
 * it happened and what they were, since an expired guest and a lapsed member
 * both land here but need different wording.
 * @param {string} id - User UUID
 * @returns {Promise<object>}
 */
async function demoteUser(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');
  if (user.role === 'ADMIN') throw new ForbiddenError('Cannot change admin role');

  return prisma.user.update({
    where: { id },
    data: {
      role: 'PENDING',
      demotedAt: new Date(),
      // Already PENDING: keep whatever they were before, not PENDING itself.
      previousRole: user.role === 'PENDING' ? user.previousRole : user.role,
    },
    select: { id: true, username: true, role: true },
  });
}

/**
 * Deletes a user and all their associated data (cascaded by Prisma).
 * Admins cannot be deleted via this endpoint.
 * @param {string} id - User UUID
 * @param {string} requesterId - The admin making the request (cannot self-delete)
 */
async function deleteUser(id, requesterId) {
  if (id === requesterId) throw new ForbiddenError('Cannot delete your own account');

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');
  if (user.role === 'ADMIN') throw new ForbiddenError('Cannot delete an admin account');

  await prisma.user.delete({ where: { id } });
}

/**
 * Returns bandwidth usage per user, with daily breakdown.
 * @param {number} days - Number of days to look back (default 30)
 * @returns {Promise<object>} { trackingSince, users: [{ userId, username, totalBytes, days: [{ date, bytes }] }] }
 */
async function getBandwidthStats(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  // Get earliest log date (tracking since)
  const earliest = await prisma.bandwidthLog.findFirst({
    orderBy: { date: 'asc' },
    select: { date: true },
  });

  const logs = await prisma.bandwidthLog.findMany({
    where: { date: { gte: since } },
    include: { user: { select: { username: true } } },
    orderBy: [{ userId: 'asc' }, { date: 'asc' }],
  });

  // Group by user
  const userMap = new Map();
  for (const log of logs) {
    if (!userMap.has(log.userId)) {
      userMap.set(log.userId, {
        userId: log.userId,
        username: log.user.username,
        totalBytes: BigInt(0),
        days: [],
      });
    }
    const entry = userMap.get(log.userId);
    entry.totalBytes += log.bytes;
    entry.days.push({ date: log.date, bytes: log.bytes.toString() });
  }

  // Sort by totalBytes descending
  const users = Array.from(userMap.values())
    .sort((a, b) => (b.totalBytes > a.totalBytes ? 1 : -1))
    .map(u => ({ ...u, totalBytes: u.totalBytes.toString() }));

  return {
    trackingSince: earliest?.date || null,
    periodDays: days,
    users,
  };
}

/**
 * Who has been using 唱卡, and how it is going for them right now.
 *
 * Read-only and computed on request: every number comes from rows the feature
 * already writes while it runs, so there is nothing to keep up to date and no
 * job to schedule. Opening the page is what refreshes it.
 *
 * Seven days, matching what capture data is kept for. The prune job drops
 * capture events after thirty (cron, 03:30 daily), so a longer window would
 * quietly show a shorter history than it claimed to -- a 90-day view that can
 * only ever see 30 is worse than not offering one.
 *
 * Which captures count as 唱卡 is decided by the EVENT, not by its session.
 * A session's `mode` is rewritten every time the singer re-aims the connection
 * (setTarget writes `mode: target === 'live' ? 'live' : 'playlist'`), so it
 * says where captures are going NOW, not where each one came from -- switching
 * to 歌P at the end of a night retroactively hid that night's 唱卡 use, and
 * switching back pulled in 歌P captures that were never 唱卡 at all. Measured
 * over one week: 10 sessions affected, filtering by session.mode returned 7639
 * events where the truth was 4773.
 *
 * `capture_events.playlist_id` is fixed at capture time and is null exactly for
 * 唱卡, which its own schema comment says outright. Checked against live data,
 * the rows it selects carry only `resolved` and `unmapped` -- the two outcomes
 * the 唱卡 path writes -- with none of the 歌P ones mixed in.
 *
 * "Last seen" is the last capture, not the last time they pressed 开始.
 * Measured on live data those differ by nearly a day for a singer who opened a
 * session and barely sang, and the session time made them look active when
 * they were not. It also drops anyone who started a session and captured
 * nothing at all, which is the honest answer to "who is using this".
 *
 * The one-hour columns split the way the singer's own screen does:
 *
 *   已确认  a reviewer signed this mapping off
 *   待确认  it resolved and played, but nobody has vouched for the recording
 *   未配置  the game showed a song we have no mapping for
 *
 * That split is read from the event's stored snapshot rather than by joining
 * the mapping table now. It records what the singer actually saw at the time,
 * which is what "how is it going" means; a later approval does not rewrite
 * history.
 */
async function getLiveUsage() {
  // count(*) is BigInt in Postgres and res.json cannot serialise that, so the
  // cast happens here rather than being mapped over afterwards.
  const rows = await prisma.$queryRaw`
    SELECT u.id                                         AS "userId",
           u.username,
           MAX(e.created_at)                            AS "lastCaptureAt",
           COUNT(*)::int                                AS "weekTotal",
           COUNT(*) FILTER (
             WHERE e.created_at > NOW() - INTERVAL '1 hour'
               AND e.outcome = 'resolved'
               AND (e.candidates->>'approved')::boolean IS TRUE
           )::int                                       AS "hourConfirmed",
           COUNT(*) FILTER (
             WHERE e.created_at > NOW() - INTERVAL '1 hour'
               AND e.outcome = 'resolved'
               AND (e.candidates->>'approved')::boolean IS NOT TRUE
           )::int                                       AS "hourPending",
           COUNT(*) FILTER (
             WHERE e.created_at > NOW() - INTERVAL '1 hour'
               AND e.outcome = 'unmapped'
           )::int                                       AS "hourUnmapped"
      FROM capture_events e
      JOIN capture_sessions s ON s.id = e.session_id
      JOIN users u            ON u.id = s.user_id
     WHERE e.playlist_id IS NULL
       AND e.created_at > NOW() - INTERVAL '7 days'
     GROUP BY u.id, u.username
     ORDER BY MAX(e.created_at) DESC
  `;

  // Timestamps go out as ISO strings and are formatted in the browser. The
  // server runs on UTC; sending a preformatted time would show the admin
  // 05:31 for a capture that happened at 13:31 where they are sitting.
  return { days: 7, users: rows };
}

/**
 * Who has been tagging songs into playlists, by hand or through 自动打标.
 *
 * Read from tag_events, an append-only log of the act, not from `likes`.
 * `likes` records whether a clip is marked right now, which is what a playlist
 * renders from -- so untagging deletes the row and clearing a playlist deletes
 * all of them. Counting what survived measured how recently someone tidied up
 * rather than how much they played: one singer had tagged 3,704 songs in ten
 * days and had 188 likes left, and this view showed their last activity as
 * five days earlier while they were tagging that same afternoon. The people
 * playing most were the ones whose history vanished fastest.
 *
 * Tagging the same song on two nights counts twice, on purpose -- it happened
 * twice. Untagging counts for nothing and cancels nothing.
 *
 * Every singer's saved song marks, whole-history by nature: song_prefs IS the
 * archive — one row per singer per recording, updated in place, no time
 * dimension — so this is one aggregate over current state, computed when the
 * tab is opened and stored nowhere. It counts what is saved now, not edits
 * ever made: a mark the singer cleared (or forgetTracks removed with a song)
 * is gone from here too, which is what "保存的记录" means.
 *
 * The LOCAL/__default__ sentinel row holds a singer's global key and tempo,
 * describes the singer rather than any song, and would inflate every count by
 * one — excluded.
 */
async function getLiveMarks() {
  const rows = await prisma.$queryRaw`
    SELECT u.username,
           COUNT(*)::int             AS total,
           COUNT(sp.speed)::int      AS speed,
           COUNT(sp.pitch)::int      AS pitch,
           COUNT(sp.note)::int       AS note,
           COUNT(sp.color_tag)::int  AS color
      FROM song_prefs sp
      JOIN users u ON u.id = sp.user_id
     WHERE NOT (sp.source = 'LOCAL' AND sp.external_id = '__default__')
     GROUP BY u.username
     ORDER BY total DESC, u.username ASC`;
  return { users: rows };
}

/**
 * Own vs shared compares the tagger against the playlist's owner. Tagging in
 * someone else's shared playlist is how a guest takes part, and lumping the
 * two together would hide that.
 *
 * The 自动打标 column says whether any of these tags were written
 * automatically, not whether a setting is on -- there is no such setting.
 * Which songs are tagged automatically is decided per song by the match: an
 * unambiguous hit in the current playlist is tagged on arrival, anything else
 * waits for a human.
 *
 * Thirty days, matching what the nightly prune keeps. The table is bounded by
 * that rather than growing: measured at 689 tags a day, it settles near 20,000
 * rows and about 3MB.
 */
async function getTaggingUsage() {
  const rows = await prisma.$queryRaw`
    SELECT u.id                                              AS "userId",
           u.username,
           MAX(t.created_at)                                 AS "lastTagAt",
           COUNT(*)::int                                     AS "total",
           COUNT(*) FILTER (WHERE t.user_id = pl.user_id)::int  AS "ownCount",
           COUNT(*) FILTER (WHERE t.user_id <> pl.user_id)::int AS "sharedCount",
           -- Whether they let 自动打标 do it, rather than a setting they turned
           -- on: which songs are tagged automatically is decided per song by
           -- the match, so the honest question is "does this person use it".
           BOOL_OR(t.auto)                                   AS "usedCapture"
      FROM tag_events t
      JOIN users u      ON u.id = t.user_id
      -- Left, not inner: a playlist can be deleted after the tagging happened,
      -- and losing the playlist must not lose the fact that they were playing.
      LEFT JOIN playlists pl ON pl.id = t.playlist_id
     WHERE t.created_at > NOW() - INTERVAL '30 days'
     GROUP BY u.id, u.username
     ORDER BY MAX(t.created_at) DESC
  `;

  return { days: 30, users: rows };
}

/**
 * Returns all playlists owned by the given user, for admin view-and-copy.
 * Shaped like playlistService.getUserPlaylists but from the admin's perspective:
 * the admin is never the owner, and may always copy.
 * @param {string} userId - The owner whose playlists to list
 * @returns {Promise<Array>}
 */
async function listUserPlaylists(userId) {
  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true },
  });
  if (!owner) throw new NotFoundError('User');

  const shape = (p, isShared) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    isPublic: p.isPublic,
    isOwner: false,
    isShared,
    canCopy: true,
    ownerName: p.user.username,
    clipCount: p._count.playlistClips,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });

  // Playlists this user owns.
  const owned = await prisma.playlist.findMany({
    where: { userId },
    include: {
      _count: { select: { playlistClips: true } },
      user: { select: { username: true } },
    },
    orderBy: { name: 'asc' },
  });

  // Playlists shared WITH this user (via playlist_shares); owned by someone else.
  const sharedRows = await prisma.playlistShare.findMany({
    where: { userId },
    include: {
      playlist: {
        include: {
          _count: { select: { playlistClips: true } },
          user: { select: { username: true } },
        },
      },
    },
    orderBy: { playlist: { name: 'asc' } },
  });

  return {
    owner,
    playlists: owned.map((p) => shape(p, false)),
    sharedPlaylists: sharedRows.map((r) => shape(r.playlist, true)),
  };
}

const BILLING_SELECT = {
  id: true, username: true, role: true,
  expiresAt: true, monthlyFee: true, paymentStatus: true, billingNotes: true,
  deviceLimit: true, entitlements: true,
};

/**
 * Update any subset of a user's billing fields.
 * @param {string} id
 * @param {{ expiresAt?: Date|null, monthlyFee?: string|number|null, paymentStatus?: string|null, billingNotes?: string|null, entitlements?: string[] }} data
 */
async function updateBilling(id, data) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');

  const patch = {};
  if ('expiresAt' in data) patch.expiresAt = data.expiresAt;
  if ('monthlyFee' in data) patch.monthlyFee = data.monthlyFee;
  if ('paymentStatus' in data) patch.paymentStatus = data.paymentStatus;
  if ('billingNotes' in data) patch.billingNotes = data.billingNotes;
  if ('deviceLimit' in data) patch.deviceLimit = data.deviceLimit;
  if ('entitlements' in data) patch.entitlements = data.entitlements;

  return prisma.user.update({ where: { id }, data: patch, select: BILLING_SELECT });
}

/**
 * Extend a user's subscription by one calendar month.
 * Base = now if expiresAt is null or in the past, else current expiresAt.
 * @param {string} id
 */
async function extendOneMonth(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');

  const now = new Date();
  const base = user.expiresAt && user.expiresAt.getTime() > now.getTime() ? user.expiresAt : now;
  const expiresAt = addOneMonth(base);

  return prisma.user.update({ where: { id }, data: { expiresAt }, select: BILLING_SELECT });
}

/**
 * Reset a user's password to a freshly generated temp password.
 * Returns the plaintext temp password ONCE so the admin can relay it; it is
 * never stored in plaintext. Admins cannot be reset here (recover via
 * scripts/seed-admins.js). Existing sessions are left intact — already-issued
 * JWTs stay valid until they expire; only new logins require the temp password.
 * @param {string} id - User UUID
 * @returns {Promise<{ id: string, username: string, tempPassword: string }>}
 */
async function resetPassword(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User');
  if (user.role === 'ADMIN') throw new ForbiddenError('Cannot reset an admin password');

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
  await prisma.user.update({ where: { id }, data: { passwordHash } });

  return { id: user.id, username: user.username, tempPassword };
}

module.exports = { listUsers, listPending, approveUser, makeGuest, demoteUser, deleteUser, getBandwidthStats, getLiveUsage, getLiveMarks, getTaggingUsage, listUserPlaylists, updateBilling, extendOneMonth, resetPassword, generateTempPassword };
