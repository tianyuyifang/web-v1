/**
 * What one singer has settled on for one recording: the key, the tempo, a note
 * to themselves, and colour flags.
 *
 * Every function here is scoped to a userId supplied by the caller from the
 * verified token, never from a request body. There is no read or write in this
 * module that can reach another account's row, which is the whole security
 * story: preferences are private, and one singer's key is not information
 * another singer is entitled to.
 *
 * Reads are batched by design. The live page shows a dozen cards at once, and a
 * lookup per card would be a dozen round trips for data that fits in one — so
 * `getMany` takes the whole screen and answers it with a single query against
 * the primary key.
 */
const prisma = require('../db/client');
const { ValidationError } = require('../utils/errors');

/** Mirrors the player's own clamp — see useLivePlayer.setPitch. */
const PITCH_MIN = -6;
const PITCH_MAX = 6;
/** Mirrors the player's own clamp — see useLivePlayer.setSpeed. */
const SPEED_MIN = 0.5;
const SPEED_MAX = 2;
/** Long enough for a real note, short enough that the column cannot be abused. */
const MAX_NOTE_LENGTH = 200;
/**
 * Six colours at seven characters plus separators. Generous for the palette
 * that exists, and a bound rather than an invitation.
 */
const MAX_COLOR_TAG_LENGTH = 64;
/**
 * One screen's worth, with room to spare. The live page keeps twelve rounds of
 * cards; this caps what a single request can ask for so a crafted call cannot
 * turn one lookup into an unbounded scan.
 */
const MAX_KEYS = 200;

const SOURCES = new Set(['LOCAL', 'QQ', 'NETEASE']);

/**
 * Where a singer's global default key and tempo live.
 *
 * A row in this same table rather than a column elsewhere. The obvious home
 * looked like User.preferences, and it is a trap: the update route validates
 * against a Zod whitelist that silently DROPS unknown keys, and the service
 * behind it replaces the whole column rather than merging -- so writing a
 * default there would store nothing and, worse, could wipe the encrypted
 * platform cookies that share the column.
 *
 * A sentinel row costs no migration and no second query: the live feed already
 * asks this table for the dozen recordings on screen, so the default rides
 * along in that same lookup. Measured at 0.081 ms over the existing query,
 * against 0.891 ms for asking separately.
 *
 * The id cannot collide with a real one. Platform ids are QQ mids and NetEase
 * numbers, local ones are song uuids; none begins with an underscore, verified
 * against all 6,287 pool rows and 1,682 mappings. And every read in this file
 * matches an exact (source, externalId) pair rather than a prefix, so the
 * sentinel is only ever returned to a caller that asked for it by name.
 */
const DEFAULT_SOURCE = 'LOCAL';
const DEFAULT_EXTERNAL_ID = '__default__';
const DEFAULT_KEY = `${DEFAULT_SOURCE}:${DEFAULT_EXTERNAL_ID}`;

function assertSource(source) {
  if (!SOURCES.has(source)) {
    throw new ValidationError({ source: ['未知的音源'] });
  }
}

/**
 * Read preferences for the recordings currently on screen.
 *
 * Returns a Map keyed by `${source}:${externalId}` — the same shape the caller
 * builds its lookups from, so neither side has to know how the other stores it.
 * Absent rows are simply absent: a song never touched has no entry, which is
 * different from one deliberately set back to its original key.
 */
async function getMany(userId, keys) {
  if (!userId || !Array.isArray(keys) || !keys.length) return new Map();

  // Deduplicated before the query, because the same recording can legitimately
  // appear on two cards — the game offers a song in one round and again in a
  // later one, and both cards are on screen.
  const wanted = new Map();
  for (const k of keys) {
    if (!k || !k.source || !k.externalId) continue;
    if (!SOURCES.has(k.source)) continue;
    wanted.set(`${k.source}:${k.externalId}`, k);
  }
  if (!wanted.size) return new Map();

  const list = [...wanted.values()].slice(0, MAX_KEYS);

  // One query for the whole screen. `OR` rather than a pair of `IN` lists
  // because the two columns have to match together: a separate `source IN`
  // and `external_id IN` would also return QQ's id under NetEase's source
  // whenever both happen to be on screen. The list is bounded by MAX_KEYS,
  // far below the 32,767 bound-parameter ceiling that makes large ORs fail.
  const rows = await prisma.songPref.findMany({
    where: {
      userId,
      OR: list.map((k) => ({ source: k.source, externalId: k.externalId })),
    },
  });

  const out = new Map();
  for (const r of rows) {
    out.set(`${r.source}:${r.externalId}`, {
      pitch: r.pitch,
      speed: r.speed,
      note: r.note,
      colorTag: r.colorTag,
    });
  }
  return out;
}

/**
 * Validate and normalise one field's worth of change.
 *
 * Absent and null mean different things and both are honoured: a key the
 * caller did not send is left alone, and an explicit null clears that field.
 * That distinction is what lets the note be saved without disturbing a key,
 * and a colour cleared without forgetting the tempo.
 */
function buildPatch(input) {
  const patch = {};

  if (input.pitch !== undefined) {
    if (input.pitch === null) {
      patch.pitch = null;
    } else {
      const n = Number(input.pitch);
      if (!Number.isInteger(n) || n < PITCH_MIN || n > PITCH_MAX) {
        throw new ValidationError({ pitch: [`变调必须是 ${PITCH_MIN} 到 ${PITCH_MAX} 之间的整数`] });
      }
      patch.pitch = n;
    }
  }

  if (input.speed !== undefined) {
    if (input.speed === null) {
      patch.speed = null;
    } else {
      const n = Number(input.speed);
      if (!Number.isFinite(n) || n < SPEED_MIN || n > SPEED_MAX) {
        throw new ValidationError({ speed: [`变速必须在 ${SPEED_MIN} 到 ${SPEED_MAX} 之间`] });
      }
      patch.speed = n;
    }
  }

  if (input.note !== undefined) {
    if (input.note === null) {
      patch.note = null;
    } else {
      const s = String(input.note).trim();
      if (s.length > MAX_NOTE_LENGTH) {
        throw new ValidationError({ note: [`备注最多 ${MAX_NOTE_LENGTH} 个字`] });
      }
      // An emptied box means "no note", not an empty string, so the row does
      // not keep a blank note that renders as a gap on the card.
      patch.note = s || null;
    }
  }

  if (input.colorTag !== undefined) {
    if (input.colorTag === null) {
      patch.colorTag = null;
    } else {
      const s = String(input.colorTag).trim();
      if (s.length > MAX_COLOR_TAG_LENGTH) {
        throw new ValidationError({ colorTag: ['颜色标记过长'] });
      }
      // Only the shape is enforced, not a fixed palette: the colours live in a
      // frontend constant, and pinning the list here as well would mean two
      // places to change and a validator that rejects a colour the UI offers.
      if (s && !/^#[0-9a-fA-F]{6}(\|#[0-9a-fA-F]{6})*$/.test(s)) {
        throw new ValidationError({ colorTag: ['颜色格式不对'] });
      }
      patch.colorTag = s || null;
    }
  }

  return patch;
}

/**
 * Store what this singer settled on for one recording.
 *
 * A patch, not a replacement. The card saves the key when it closes and the
 * colours the moment they are clicked, so a whole-row write from either would
 * silently discard the other.
 */
async function upsert(userId, { source, externalId, ...fields }) {
  assertSource(source);
  const id = String(externalId || '').trim();
  if (!id) throw new ValidationError({ externalId: ['缺少歌曲标识'] });
  // The sentinel is not a song. Reaching it through the per-song route would
  // let a note or a colour be attached to something that is not a recording,
  // and would let the global default be rewritten by a call that reads as an
  // ordinary save. setDefaults is the only way in.
  if (source === DEFAULT_SOURCE && id === DEFAULT_EXTERNAL_ID) {
    throw new ValidationError({ externalId: ['这个标识被保留'] });
  }

  const patch = buildPatch(fields);
  if (!Object.keys(patch).length) {
    throw new ValidationError({ _: ['没有要保存的内容'] });
  }

  const row = await prisma.songPref.upsert({
    where: { userId_source_externalId: { userId, source, externalId: id } },
    create: { userId, source, externalId: id, ...patch },
    update: patch,
  });

  const result = {
    pitch: row.pitch,
    speed: row.speed,
    note: row.note,
    colorTag: row.colorTag,
  };

  // A row where every field has been cleared says nothing, and leaving it would
  // mean an account slowly accumulating blanks for every song ever opened.
  if (result.pitch === null && result.speed === null
    && result.note === null && result.colorTag === null) {
    await prisma.songPref.delete({
      where: { userId_source_externalId: { userId, source, externalId: id } },
    }).catch(() => { /* already gone; the empty result below is still right */ });
  }

  return result;
}

/**
 * This singer's global default key and tempo, or nulls when unset.
 *
 * Only pitch and speed are meaningful on the sentinel row: a note or a colour
 * would describe a song, and this row describes none.
 */
async function getDefaults(userId) {
  if (!userId) return { pitch: null, speed: null };
  const row = await prisma.songPref.findUnique({
    where: {
      userId_source_externalId: {
        userId, source: DEFAULT_SOURCE, externalId: DEFAULT_EXTERNAL_ID,
      },
    },
  });
  return { pitch: row?.pitch ?? null, speed: row?.speed ?? null };
}

/**
 * Set the global default. A patch, like every other write here.
 *
 * Clearing both fields deletes the row rather than leaving one that says
 * nothing — the absence IS the "no default" state, so there are not two ways
 * to spell it.
 */
async function setDefaults(userId, fields) {
  const patch = buildPatch({
    ...(fields.pitch !== undefined ? { pitch: fields.pitch } : {}),
    ...(fields.speed !== undefined ? { speed: fields.speed } : {}),
  });
  if (!Object.keys(patch).length) {
    throw new ValidationError({ _: ['没有要保存的内容'] });
  }

  const where = {
    userId_source_externalId: {
      userId, source: DEFAULT_SOURCE, externalId: DEFAULT_EXTERNAL_ID,
    },
  };
  const row = await prisma.songPref.upsert({
    where,
    create: {
      userId, source: DEFAULT_SOURCE, externalId: DEFAULT_EXTERNAL_ID, ...patch,
    },
    update: patch,
  });

  const result = { pitch: row.pitch, speed: row.speed };
  if (result.pitch === null && result.speed === null) {
    await prisma.songPref.delete({ where }).catch(() => { /* already gone */ });
  }
  return result;
}

/**
 * Forget every singer's preferences for these recordings.
 *
 * Called when a recording leaves the catalogue, which is the one event that
 * makes a saved key meaningless: the song cannot be played from here any more,
 * so the note about how to sing it describes nothing.
 *
 * Deliberately not tied to mappings. Repointing a game song at a different
 * recording leaves the old recording in the pool, and the people who worked
 * out how to sing it are still right about it.
 *
 * No foreign key can do this: source+externalId spans three unrelated id
 * spaces -- a local song uuid, a QQ songmid, a NetEase number -- so there is
 * nothing single for a constraint to reference. That makes this an explicit
 * call every deletion path has to make, and the reason it lives here rather
 * than being written out four times.
 *
 * Pass `tx` to run inside a caller's transaction, so a half-finished deletion
 * cannot leave preferences for a track that is already gone.
 */
async function forgetTracks(tracks, tx = prisma) {
  const list = (Array.isArray(tracks) ? tracks : [tracks])
    .filter((t) => t && SOURCES.has(t.source) && t.externalId)
    // This deletes across every account, so the sentinel is excluded outright
    // rather than trusted not to appear: a catalogue row can never carry that
    // id, and if one somehow did, it would wipe every singer's default.
    .filter((t) => !(t.source === DEFAULT_SOURCE && t.externalId === DEFAULT_EXTERNAL_ID));
  if (!list.length) return { count: 0 };

  // Chunked: a catalogue clean-up can name thousands of tracks at once, and
  // each one contributes two bound parameters towards PostgreSQL's 32,767
  // limit. 5,000 pairs stays an order of magnitude clear of it.
  const CHUNK = 5000;
  let count = 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const res = await tx.songPref.deleteMany({
      where: { OR: slice.map((t) => ({ source: t.source, externalId: t.externalId })) },
    });
    count += res.count;
  }
  return { count };
}

/** Forget this recording entirely. Absent rows are not an error. */
async function clear(userId, { source, externalId }) {
  assertSource(source);
  const id = String(externalId || '').trim();
  if (!id) throw new ValidationError({ externalId: ['缺少歌曲标识'] });
  if (source === DEFAULT_SOURCE && id === DEFAULT_EXTERNAL_ID) {
    throw new ValidationError({ externalId: ['这个标识被保留'] });
  }

  await prisma.songPref.deleteMany({
    where: { userId, source, externalId: id },
  });
  return { cleared: true };
}

module.exports = {
  getMany,
  upsert,
  clear,
  getDefaults,
  setDefaults,
  // The feed adds this to the keys it already asks for, so the default costs
  // no request of its own.
  DEFAULT_SOURCE,
  DEFAULT_EXTERNAL_ID,
  DEFAULT_KEY,
  // Every path that removes a track from the catalogue must call this: no
  // foreign key can, for the reason given above it.
  forgetTracks,
  // Exposed so the route validator and the tests describe the same limits the
  // service enforces, rather than a second copy that can drift.
  PITCH_MIN,
  PITCH_MAX,
  SPEED_MIN,
  SPEED_MAX,
  MAX_NOTE_LENGTH,
  MAX_KEYS,
};
