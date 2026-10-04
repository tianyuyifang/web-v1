/**
 * QQ打标: the user's own QQ lists, read from their browser (用户 IP mode).
 *
 * The same reads the server makes (backend qqSource.js listMyPlaylists /
 * getPlaylistRows / likedMap, mirrored call for call), made from the user's
 * own address through lib/qqDirectEngine's sandbox. What they return goes back
 * to the server (annotate / supply), which keeps it exactly where its own read
 * would have, so starting a run and matching its captures need no request from
 * the server's address.
 *
 * Only when the server says so: /platform-tagging/qq-read-session answers
 * `browser` only while 档位设置 → QQ 播放解析 is 用户 IP for this user, and
 * hands over the account values the reads need -- never the cookie. Every
 * function here rejects on any failure, and the page then asks the server as
 * before; nothing is ever half-read.
 *
 * Verified 2026-10-03 against a real account, GET with the account in `comm`
 * and no Referer: the listing (301 lists), 我喜欢 (23/23), a 4350-song list in
 * pages of 1000, liked state (20/20) and the collected lists (69, pages of 50).
 */
import { platformTaggingAPI } from "@/lib/api";

const LIKES_DIR_ID = 201;
// Short, so a change of mode in 档位设置 reaches an open page within minutes.
const SESSION_TTL_MS = 5 * 60 * 1000;
const READ_TIMEOUT_MS = 15000;

let session = null; // { at, mode, uin, musicKey, euin }
let engine = null;

async function loadEngine() {
  if (!engine) engine = await import("@/lib/qqDirectEngine");
  return engine;
}

/** The account values, or null when this user's lists are read by the server. */
export async function readSession() {
  if (session && Date.now() - session.at < SESSION_TTL_MS) return session.mode === "browser" ? session : null;
  try {
    const res = await platformTaggingAPI.qqReadSession();
    session = { at: Date.now(), ...res.data };
  } catch {
    session = { at: Date.now() - SESSION_TTL_MS + 60 * 1000, mode: "server" };
  }
  return session.mode === "browser" && session.uin && session.musicKey ? session : null;
}

/** Forget the account values (e.g. QQ said the key is dead), so the next read asks again. */
export function dropSession() {
  session = null;
}

function refused(code) {
  const e = new Error(`QQ read refused (code ${code})`);
  e.code = code;
  return e;
}

function stopped() {
  const e = new Error("read no longer wanted");
  e.code = "stopped";
  return e;
}

async function call(s, req1, count, alive = () => true) {
  // The user moved on (another list): stop here rather than reading the rest
  // of a list nobody is looking at, as the user.
  if (!alive()) throw stopped();
  const m = await loadEngine();
  count.calls += 1;
  const r = await m.readQq(s, req1, READ_TIMEOUT_MS);
  if (r.code !== 0) {
    if (r.code === 1000) dropSession();
    throw refused(r.code);
  }
  return r.data || {};
}

/**
 * A hand-over to the server. Refused (409) when this page's account values are
 * out of date -- another QQ account connected, or the mode changed: dropped,
 * so the next read asks again.
 */
async function sent(request) {
  try {
    return await request;
  } catch (err) {
    if (err?.response?.status === 409) dropSession();
    throw err;
  }
}

/** Same shape as qqSource.toLikeable. */
function toLikeable(x) {
  return {
    id: String(x.id),
    songType: Number.isInteger(x.type) ? x.type : 0,
    mid: x.mid || null,
    title: x.name || x.title || "",
    artist: (x.singer || []).map((a) => a.name).filter(Boolean).join("/"),
    durationSec: Number.isInteger(x.interval) ? x.interval : null,
    vipOnly: Boolean(x.pay && x.pay.pay_play),
  };
}

/**
 * The account's created lists, favourites first, then the ones it collected
 * -- as qqSource.listMyPlaylists, annotated by the server for search.
 */
export async function listPlaylists(s) {
  const count = { calls: 0 };
  const d = await call(s, { module: "music.musicasset.PlaylistBaseRead", method: "GetPlaylistByUin", param: { uin: String(s.uin) } }, count);
  const created = (d.v_playlist || []).map((p) => ({
    ref: `qq:${p.tid}`,
    id: String(p.tid),
    dirId: Number.isInteger(p.dirId) ? p.dirId : null,
    name: p.dirName || "",
    count: Number.isInteger(p.songNum) ? p.songNum : null,
    cover: p.picUrl || null,
    isLikes: p.dirId === LIKES_DIR_ID,
    kind: "created",
  }));
  created.sort((a, b) => Number(b.isLikes) - Number(a.isLikes));

  // The collected half is optional, as on the server: its failure never takes
  // the created lists down.
  let euin = s.euin || null;
  let euinResolved = null;
  const collected = [];
  try {
    if (!euin && created.length) {
      const first = created.find((p) => !p.isLikes) || created[0];
      const info = await call(s, {
        module: "music.srfDissInfo.DissInfo",
        method: "CgiGetDiss",
        param: { disstid: first.isLikes ? 0 : Number(first.id), dirid: first.dirId, tag: true, userinfo: true, orderlist: true, song_begin: 0, song_num: 0 },
      }, count);
      euin = info.dirinfo && info.dirinfo.encrypt_uin ? info.dirinfo.encrypt_uin : null;
      euinResolved = euin;
    }
    if (euin) {
      const PAGE = 50;
      for (let offset = 0; offset < 1000; offset += PAGE) {
        const f = await call(s, { module: "music.musicasset.PlaylistFavRead", method: "CgiGetPlaylistFavInfo", param: { uin: euin, offset, size: PAGE } }, count);
        const rows = f.v_list || [];
        collected.push(...rows.map((p) => ({
          ref: `qq:${p.tid}`,
          id: String(p.tid),
          dirId: Number.isInteger(p.dirId) ? p.dirId : null,
          name: p.name || "",
          count: Number.isInteger(p.songnum) ? p.songnum : null,
          cover: p.logo || null,
          isLikes: false,
          kind: "collected",
        })));
        if (rows.length < PAGE || (Number.isInteger(f.total) && collected.length >= f.total)) break;
      }
    }
  } catch {
    /* created lists stand on their own */
  }

  const res = await sent(platformTaggingAPI.annotatePlaylists({
    uin: String(s.uin),
    playlists: [...created, ...collected],
    euin: euinResolved,
    calls: count.calls,
  }));
  if (euinResolved && session) session.euin = euinResolved;
  return res.data.playlists || [];
}

/** A row as the server's supply route takes it, or null when it would be refused. */
function toRow(x) {
  if (!/^\d{1,20}$/.test(x.id)) return null;
  const clip = (v, n) => String(v || "").slice(0, n);
  return [
    x.id,
    Math.min(Math.max(x.songType | 0, 0), 1000),
    x.mid ? clip(x.mid, 40) : null,
    clip(x.title, 300),
    clip(x.artist, 500),
    Number.isInteger(x.durationSec) && x.durationSec >= 0 && x.durationSec <= 100000 ? x.durationSec : null,
    Boolean(x.vipOnly),
  ];
}

/**
 * One list's songs and which are liked -- as qqSource.getPlaylistRows plus
 * likedMap -- handed to the server, which answers like GET .../songs.
 * `alive()` false stops the read between calls (the user moved on).
 */
export async function readPlaylistSongs(s, { ref, dirId, isLikes, count: listed }, alive = () => true) {
  const startedAt = Date.now();
  const count = { calls: 0 };
  const likesList = isLikes || dirId === LIKES_DIR_ID;
  const tid = String(ref).split(":")[1];
  const PAGE = 1000;
  const MAX = 5000;
  const songs = [];
  let title = null;
  let total = null;
  for (let begin = 0; begin < MAX; begin += PAGE) {
    const d = await call(s, {
      module: "music.srfDissInfo.DissInfo",
      method: "CgiGetDiss",
      param: {
        disstid: likesList ? 0 : Number(tid),
        ...(dirId != null ? { dirid: dirId } : {}),
        tag: true, userinfo: true, orderlist: true, song_begin: begin, song_num: PAGE,
      },
    }, count, alive);
    if (title == null) title = (d.dirinfo && d.dirinfo.title) ?? null;
    if (total == null) total = Number.isInteger(d.total_song_num) ? d.total_song_num : null;
    const page = d.songlist || [];
    if (!page.length) break;
    songs.push(...page.map(toLikeable));
    if (total != null && songs.length >= total) break;
  }
  // An empty answer for a list that has songs: not a list to show as empty
  // (a private list, or QQ not answering as this user -- e.g. a browser that
  // sent a Referer after all) -- the server decides. The listing's own count
  // counts too, as QQ may then report no total at all.
  if (!songs.length && (total > 0 || listed > 0)) throw refused("empty");

  const likedIds = [];
  const ids = [...new Set(songs.map((x) => x.id))];
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const f = await call(s, { module: "music.musicasset.SongFavRead", method: "IsSongFanById", param: { v_songId: slice.map(Number) } }, count, alive);
    const fan = f.m_fan || {};
    // QQ answers every id it was asked about, liked or not (50 of 50 when
    // checked). One missing is an answer not to trust: a song taken as not
    // liked would be liked again by a run -- a write HEAD's server read would
    // not have made. The server reads instead.
    if (slice.some((id) => !(id in fan))) throw refused("partial");
    for (const id of slice) if (fan[id]) likedIds.push(id);
  }
  // 我喜欢 with nothing liked in it cannot be right.
  if (likesList && songs.length && !likedIds.length) throw refused("partial");

  if (!alive()) throw stopped();
  const rows = songs.map(toRow).filter(Boolean);
  const res = await sent(platformTaggingAPI.supplySongs(ref, {
    uin: String(s.uin),
    title: title == null ? null : String(title).slice(0, 300),
    rows,
    likedIds,
    readMs: Date.now() - startedAt,
    dirId: dirId ?? null,
    isLikes: likesList,
    calls: count.calls,
  }));
  return res.data;
}
