/**
 * The pure half of lib/qqDirect: what to ask QQ for, and how to read the
 * answer. No browser APIs and no imports, so the same file can be run in Node
 * against the server's own resolver to check the two choose the same file.
 *
 * The choosing rule is the server's (routes/mappings.js, resolvePreview):
 * vocals first if asked, then the requested quality and every lower one, and
 * the first with a URL wins. The difference is that every candidate goes in one
 * GetVkey request (measured 2026-09-30: one call answers all four qualities)
 * instead of one request per candidate.
 */

// What a current desktop client reports; the same values the server sends.
export const CLIENT = { ct: 11, cv: 13020508, v: 13020508, tmeAppID: "qqmusic" };

export const TIERS = {
  m4a: ["C400", ".m4a"],
  mp3_128: ["M500", ".mp3"],
  mp3_320: ["M800", ".mp3"],
  flac: ["F000", ".flac"],
};
export const TIER_LADDER = ["flac", "mp3_320", "mp3_128", "m4a"];

/** The server's defaults for a request, so both paths answer the same question. */
export function normalise(opts) {
  return {
    tier: TIERS[opts?.tier] ? opts.tier : "mp3_128",
    vocalsOnly: opts?.vocalsOnly === true,
  };
}

export function comm(s) {
  return { ...CLIENT, uin: String(s.uin), authst: s.musicKey, format: "json", inCharset: "utf-8", outCharset: "utf-8" };
}

export function cdnRequest(s, guid) {
  return {
    comm: comm(s),
    req_1: {
      module: "music.audioCdnDispatch.cdnDispatch",
      method: "GetCdnDispatch",
      param: { guid, uid: "0", use_new_domain: 1, use_ipv6: 1 },
    },
  };
}

/**
 * The hosts a play URL may start with. Same filter as the server, plus: only
 * QQ's own hosts, over https -- this ends up as an audio element's src, so
 * nothing else is taken from a response.
 */
export function parseCdn(json) {
  const sip = json?.req_1?.data?.sip;
  return (Array.isArray(sip) ? sip : [])
    .filter((h) => typeof h === "string" && !h.startsWith("http://ws"))
    .map((h) => h.replace(/^http:\/\//, "https://"))
    .filter((h) => /^https:\/\/[a-z0-9.-]+\.qq\.com\/$/i.test(h));
}

/** Asked without the account, as the server does. */
export function detailRequest(mid) {
  return {
    comm: { ct: 24, cv: 0 },
    req_1: { module: "music.pf_song_detail_svr", method: "get_song_detail_yqq", param: { song_mid: mid } },
  };
}

/**
 * vs[9] is the separated-vocal media id; absent on songs QQ has not separated.
 * Undefined (not null) when the answer is not a normal one -- a refusal or a
 * rate limit -- which the server would surface as an error, not as "no stem".
 */
export function parseMediaMid(json) {
  if (json?.code !== 0 || json?.req_1?.code !== 0) return undefined;
  const vs = json?.req_1?.data?.track_info?.vs;
  return Array.isArray(vs) && typeof vs[9] === "string" && vs[9] ? vs[9] : null;
}

/** The candidates in the server's order, each with the file QQ knows it by. */
export function attemptsFor(mid, o, mediaMid) {
  const from = TIER_LADDER.indexOf(o.tier);
  return [
    ...(o.vocalsOnly ? [{ vocals: true, tier: o.tier }] : []),
    ...TIER_LADDER.slice(from).map((t) => ({ vocals: false, tier: t })),
  ].map((a) => ({
    ...a,
    file: a.vocals
      ? (mediaMid ? `O801${mediaMid}.ogg` : null)
      : `${TIERS[a.tier][0]}${mid}${mid}${TIERS[a.tier][1]}`,
  }));
}

export function vkeyRequest(s, mid, attempts, guid) {
  const files = attempts.filter((a) => a.file).map((a) => a.file);
  return {
    comm: comm(s),
    req_1: {
      module: "music.vkey.GetVkey",
      method: "UrlGetVkey",
      param: {
        uin: String(s.uin),
        filename: files,
        guid,
        songmid: files.map(() => mid),
        songtype: files.map(() => 0),
        ctx: 0,
      },
    },
  };
}

/**
 * Read a GetVkey answer into the server's response shape. Returns null when
 * the answer is not one (a transport-level surprise); otherwise data.url is
 * null when no candidate had a file, with the server's reason for the last one.
 */
export function pick(json, attempts, o, host) {
  if (json?.code !== 0 || json?.req_1?.code !== 0) return null;
  const infos = json.req_1.data?.midurlinfo;
  if (!Array.isArray(infos)) return null;
  const byFile = new Map(infos.map((i) => [i?.filename, i]));

  let last = null;
  for (const a of attempts) {
    if (!a.file) { last = "no-vocals"; continue; }
    const info = byFile.get(a.file);
    const purl = info?.purl;
    if (typeof purl === "string" && purl && !purl.includes("://") && !/\s/.test(purl)) {
      return {
        kind: "external",
        url: `${host}${purl}&fromtag=3`,
        reason: null,
        playedTier: a.tier,
        vocalsPlayed: !!a.vocals,
        fellBack: a.tier !== o.tier || (o.vocalsOnly && !a.vocals),
      };
    }
    // 104003 is what every file answers once the music key has died.
    last = info?.result === 104003 ? "credential-expired" : "unavailable";
  }
  return { kind: "external", url: null, reason: last, playedTier: null, vocalsPlayed: false, fellBack: false };
}
