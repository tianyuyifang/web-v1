"use client";

/**
 * Song-mapping review.
 *
 * A mapping says "when the game shows this title and artist, play this exact
 * track". Approving one changes what plays for everybody, which is why the
 * page is limited to admins and the few users given the canEditMapping flag,
 * and why it is not linked from the navigation.
 *
 * Reviewing is mostly listening: two seconds of audio settles whether a
 * pairing is right far quicker than reading metadata. So every row has a play
 * button, and the audio streams from the platform CDN straight to the browser.
 *
 * Three tabs, because a row is in one of three genuinely different states —
 * approved, awaiting a decision, or an imported track the game has never shown
 * yet. That last count is the useful one to watch: it only falls as songs
 * actually turn up in play.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { mappingAPI, musicSourcesAPI, getStreamUrl } from "@/lib/api";
import TrackLyricPanel from "@/components/mappings/TrackLyricPanel";
import UnconfiguredPanel from "@/components/mappings/UnconfiguredPanel";
import PassagePanel from "@/components/mappings/PassagePanel";
import useAuth from "@/hooks/useAuth";

// Two levels on purpose: 歌曲 and 歌词段落 are different subjects, and the
// four song buckets are views of one subject. Flattening them into one bar put
// 歌词段落 beside 待确认 as if it were a fifth bucket of songs, which it is not.
const SONG_BUCKETS = [
  { key: "pending", label: "待确认", hint: "等待人工判断" },
  { key: "confirmed", label: "已确认", hint: "已批准，播放时直接使用" },
  { key: "unseen", label: "未遇见", hint: "已导入，但游戏里还没出现过" },
  // The one tab that looks from the game inward rather than from the catalogue
  // outward, so it is the only one that can show a gap. Its rows are game texts
  // rather than mapping rows, and it renders its own panel.
  { key: "unconfigured", label: "未配置", hint: "游戏里出现过，但曲库配不上" },
];

// "独家" rather than "曲库": these are songs we hold ourselves, so they play
// without a platform account and cannot be delisted out from under a singer.
const SOURCE_LABEL = { LOCAL: "独家", QQ: "QQ", NETEASE: "网易" };

/**
 * What the audio element is keyed on: a row, or one alternative under it.
 *
 * Playing a row and auditioning a candidate beneath it are two different
 * sounds, so they cannot share a key — the second click would be read as
 * "resume what is loaded" and replay the first. Everything that asks whether
 * this is playing goes through here, so no two callers can key it differently.
 */
function audioKey(row, candidate) {
  return candidate ? `${row.id}:${candidate.source}:${candidate.externalId}` : row.id;
}

function formatDuration(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export default function MappingsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [bucket, setBucket] = useState("pending");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ confirmed: 0, pending: 0, unseen: 0 });
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);

  const [expanded, setExpanded] = useState(null);
  /**
   * The row whose lyrics are showing, or null.
   *
   * Single rather than a set: the panel is one column beside the list, so two
   * songs cannot occupy it. Picking another row simply replaces it.
   */
  const [selected, setSelected] = useState(null);

  const togglePlayer = useCallback((row) => {
    setSelected((prev) => (prev?.id === row.id ? null : row));
  }, []);

  /**
   * Re-read the credential a row actually used.
   *
   * Called after a preview succeeds or fails, since both are moments when the
   * page's idea of the credential is most likely stale. Keyed off the row's own
   * source: a NetEase row says nothing about the QQ connection, and refreshing
   * the wrong one leaves the banner describing a platform the user did not touch.
   */
  const refreshCredentialFor = useCallback((source) => {
    const platform = source === "NETEASE" ? "netease" : source === "QQ" ? "qq" : null;
    if (!platform) return;
    musicSourcesAPI.get(platform)
      .then((r) => setCredential(r.data.source))
      .catch(() => { /* the banner simply keeps its last value */ });
  }, []);
  const [busy, setBusy] = useState(null);
  const [claimFor, setClaimFor] = useState(null);
  const [gameTitle, setGameTitle] = useState("");
  const [gameArtist, setGameArtist] = useState("");

  const [playing, setPlaying] = useState(null);
  // Which row the audio element currently holds. Kept apart from `playing` so
  // pausing does not discard the loaded track and the scrub position with it.
  const [loadedFor, setLoadedFor] = useState(null);
  /**
   * The alternative currently being auditioned: `{ rowId, candidate }`.
   *
   * Confirming has to commit what was heard. Without this the approve button
   * sends no target and writes whatever the row already pointed at, so a
   * reviewer who listened to the live version and pressed 就是这个 would have
   * silently kept the studio one — the exact mistake this feature exists to fix.
   */
  const [auditioning, setAuditioning] = useState(null);
  // Which row is showing the "不是这首" confirmation, and what it would destroy.
  const [rejecting, setRejecting] = useState(null);
  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [playError, setPlayError] = useState("");
  // Reviewing depends on a working QQ connection, so its health belongs on
  // this page too — otherwise a dying credential shows up only as playback
  // that silently stops working.
  const [credential, setCredential] = useState(null);
  const audioRef = useRef(null);

  /**
   * The search text as it was last submitted.
   *
   * Kept apart from the input's own value so typing does not fetch: the form
   * searches on submit, but load() used to depend on every keystroke, which
   * meant "chen'yi'xun" fetched the list eleven times on the way to one search.
   */
  const [submittedQuery, setSubmittedQuery] = useState("");

  const load = useCallback(async ({ append = false, cursor = null } = {}) => {
    // 未配置 is not a bucket of mapping rows and has no cursor to page; its own
    // panel fetches and holds what it needs. Asking the list route for it would
    // fail validation, and the spinner below would never clear.
    if (bucket === "unconfigured" || bucket === "passages") { setLoading(false); return; }
    setLoading(true);
    setError("");
    try {
      const res = await mappingAPI.list({ bucket, q: submittedQuery, cursor, take: 50 });
      setRows((prev) => (append ? [...prev, ...res.data.rows] : res.data.rows));
      // A fresh list is a different set of rows, so anything keyed on a row id
      // is now stale. Left alone, an audition from the previous search would
      // still be armed and 就是这个 would commit a track that is no longer on
      // screen. Appending keeps them: those rows are still there.
      if (!append) {
        setAuditioning(null);
        setRejecting(null);
      }
      setNextCursor(res.data.nextCursor);
      // Merged, not replaced. The server counts the three mapping buckets and
      // knows nothing about 未配置, which the panel reports separately — assigning
      // wholesale dropped that key and left the new tab reading 0 whenever any
      // other tab was loaded or any row approved.
      if (res.data.counts) setCounts((prev) => ({ ...prev, ...res.data.counts }));
    } catch (err) {
      // A 403 here means the account simply lacks the flag; say so plainly
      // rather than showing an empty list that looks like a bug.
      if (err.response?.status === 403) setDenied(true);
      else setError(err.response?.data?.error?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [bucket, submittedQuery]);

  useEffect(() => {
    if (authLoading || !user) return;
    load();
  }, [authLoading, user, load]);

  /**
   * Read the credential once, not on every keystroke.
   *
   * This used to sit alongside load(), which depends on the search text — so
   * typing "chen'yi'xun" fired eleven credential lookups on the way. Harmless
   * individually and invisible to the user, but it is a request per character
   * for an answer that had not changed. Playback already refreshes this when
   * it matters, via refreshCredentialFor.
   */
  useEffect(() => {
    if (authLoading || !user) return;
    musicSourcesAPI.get('qq').then((r) => setCredential(r.data.source)).catch(() => {});
  }, [authLoading, user]);

  useEffect(() => {
    if (!authLoading && !user) router.push("/login");
  }, [authLoading, user, router]);

  // Stop the audio when the page goes away, or it keeps playing over whatever
  // the user navigates to next.
  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
  }, []);

  /**
   * Show the keys a row is filed under, and the narrower delete.
   *
   * Candidates used to be fetched here, one request per row opened. They now
   * arrive with the list and are always on screen, so this is left with the
   * details that only matter when something looks wrong.
   */
  const toggleExpand = useCallback((row) => {
    setExpanded((prev) => (prev === row.id ? null : row.id));
  }, []);

  /**
   * Attach the shared audio element, wiring up progress.
   *
   * Recognising a song is not always instant: two same-titled recordings can
   * open identically and only diverge at the chorus, so a reviewer needs to
   * scrub rather than judge from the first seconds.
   */
  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;
    const el = new Audio();
    el.preload = "metadata";
    el.addEventListener("timeupdate", () => {
      setProgress({ current: el.currentTime || 0, duration: el.duration || 0 });
    });
    el.addEventListener("loadedmetadata", () => {
      setProgress({ current: el.currentTime || 0, duration: el.duration || 0 });
    });
    el.addEventListener("ended", () => setPlaying(null));
    audioRef.current = el;
    return el;
  }, []);

  /**
   * Play a row, or one of the alternatives offered under it.
   *
   * `candidate` is the whole point of auditioning: two recordings of the same
   * song can open identically and only diverge at the chorus, so the reviewer
   * has to hear the alternative before committing to it. Passing one changes
   * nothing in the database — it only resolves a different id for playback.
   *
   * Everything the audio element is keyed on therefore keys on the pair, not
   * the row: playing the row and then a candidate under it are two different
   * sounds, and keying on row.id alone would treat the second click as "resume
   * what is already loaded" and play the first one again.
   */
  const play = useCallback(async (row, candidate) => {
    setPlayError("");
    const el = ensureAudio();
    const key = audioKey(row, candidate);

    // Same thing again: pause or resume, keeping the position so scrubbing is
    // not undone by a stray click on the button.
    if (playing === key) {
      el.pause();
      setPlaying(null);
      return;
    }
    if (loadedFor === key && el.src) {
      await el.play().catch(() => {});
      setPlaying(key);
      return;
    }

    setBusy(`play:${key}`);
    try {
      const res = row.kind === "imported"
        ? await mappingAPI.previewTrack(row.id)
        : await mappingAPI.preview(
          row.id,
          candidate ? { source: candidate.source, externalId: candidate.externalId } : undefined
        );
      const { url, reason, kind } = res.data;

      // The source that matters is whatever is actually being resolved: a
      // NetEase alternative under a QQ row fails for NetEase reasons.
      const source = candidate ? candidate.source : row.source;

      if (kind === "unsupported") {
        setPlayError(`${SOURCE_LABEL[source] || source} 的试听还没做，暂时无法播放`);
        return;
      }
      // A song we hold ourselves. No url is sent for these: an <audio> element
      // cannot carry an Authorization header, so the address is built here from
      // the song id with the helper that puts the token in the query string.
      // Without this branch a 独家 row falls into the check below and reports
      // 无法试听 for a song sitting on our own disk.
      if (kind === "local" && res.data.songId) {
        el.src = getStreamUrl(res.data.songId);
        setProgress({ current: 0, duration: 0 });
        setLoadedFor(key);
        setAuditioning(candidate ? { rowId: row.id, candidate } : null);
        await el.play();
        setPlaying(key);
        return;
      }
      if (!url) {
        // A track the platform will not serve is a permissions answer, not a
        // fault, and the fix is different — so it is worded differently.
        setPlayError(reason === "credential-expired"
          ? "QQ 音乐连接已失效，请到账号页重新扫码"
          : reason === "needs-login"
            ? "这首歌需要会员，或音乐账号连接已失效，请到账号页重新扫码"
            : reason === "unavailable"
              ? "这首歌当前拿不到播放地址（可能需要会员或已下架）"
              : "无法试听");
        return;
      }
      el.src = url;
      setProgress({ current: 0, duration: 0 });
      setLoadedFor(key);
      // Remember what is being auditioned, so "就是这个" can commit exactly
      // what the reviewer heard rather than what the row still points at.
      setAuditioning(candidate ? { rowId: row.id, candidate } : null);
      await el.play();
      setPlaying(key);

      // Playing proves the credential is alive, so refresh what the page
      // believes about it. A row that plays should not leave a stale "expiring
      // soon" notice on screen.
      refreshCredentialFor(source);
    } catch (err) {
      // The server knows which credential was missing or dead for this
      // particular track; it says so, and that beats anything guessed here.
      const message = err.response?.data?.error?.message;
      setPlayError(message || "试听失败");
      // A failure is the moment the credential state is most likely stale, so
      // re-read it rather than leaving the page showing yesterday's answer.
      refreshCredentialFor(candidate ? candidate.source : row.source);
    } finally {
      // Only if still ours — see the note in act().
      setBusy((prev) => (prev === `play:${key}` ? null : prev));
    }
  }, [playing, loadedFor, ensureAudio, refreshCredentialFor]);

  /**
   * The audition in force for the row whose lyrics are open, and the audio key
   * that follows from it.
   *
   * Derived rather than stored: `auditioning` and `selected` move
   * independently — opening another row's lyrics must not inherit the first
   * row's audition — and deriving makes that impossible to get wrong.
   */
  const selectedAudition = selected && auditioning?.rowId === selected.id
    ? auditioning.candidate
    : null;
  const selectedKey = selected ? audioKey(selected, selectedAudition) : null;

  /** Seek to an absolute position, which is what a lyric timestamp gives us. */
  const seekSeconds = useCallback((seconds) => {
    const el = audioRef.current;
    if (!el || !el.duration) return;
    el.currentTime = Math.max(0, Math.min(el.duration, seconds));
  }, []);

  /**
   * Step the audio by a relative amount.
   *
   * Reads the element rather than the progress state, because while paused
   * there is no timeupdate to refresh it — nudging twice would otherwise seek
   * from the same stale position both times and appear to do nothing. The
   * result is pushed back into state for the same reason.
   */
  const nudgeSeconds = useCallback((delta) => {
    const el = audioRef.current;
    if (!el || !el.duration) return;
    const next = Math.max(0, Math.min(el.duration, el.currentTime + delta));
    el.currentTime = next;
    setProgress({ current: next, duration: el.duration });
  }, []);

  const act = useCallback(async (fn, id, after) => {
    setBusy(id);
    setError("");
    try {
      const res = await fn();
      // Merged, not replaced. The server counts the three mapping buckets and
      // knows nothing about 未配置, which the panel reports separately — assigning
      // wholesale dropped that key and left the new tab reading 0 whenever any
      // other tab was loaded or any row approved.
      if (res.data.counts) setCounts((prev) => ({ ...prev, ...res.data.counts }));
      after?.(res);
    } catch (err) {
      setError(err.response?.data?.error?.message || "操作失败");
    } finally {
      // Release only if this action is still the one holding it. Playback,
      // approval and deletion share `busy` but key it differently, so an
      // unconditional clear lets a preview finishing mid-approve re-enable the
      // approve button — and a second click sends a second POST.
      setBusy((prev) => (prev === id ? null : prev));
    }
  }, []);

  /**
   * Confirm a mapping.
   *
   * `target` names the track to commit. It defaults to whatever is currently
   * being auditioned for this row, so the button always agrees with the audio:
   * confirming after listening to an alternative saves that alternative.
   */
  const approve = (row, target) => {
    const chosen = target
      || (auditioning?.rowId === row.id ? auditioning.candidate : null);
    return act(
      () => mappingAPI.approve(row.id, chosen
        ? { source: chosen.source, externalId: chosen.externalId }
        : {}),
      row.id,
      (res) => {
        // A row leaves the list only when it leaves the bucket. Approving a
        // pending row does exactly that. Correcting the version on a row that
        // was already approved does not — it stays confirmed, so removing it
        // would read as "I just deleted the thing I was fixing", and would
        // leave the tab's count disagreeing with the rows on screen.
        setRows((prev) => (row.approved
          ? prev.map((r) => (r.id === row.id
            ? { ...res.data.mapping, poolCandidates: r.poolCandidates }
            : r))
          : prev.filter((r) => r.id !== row.id)));
        // The panel holds its own snapshot of the row, so it needs the new
        // target too — otherwise it keeps naming the track that was just
        // replaced.
        setSelected((prev) => (prev?.id === row.id
          ? { ...res.data.mapping, poolCandidates: prev.poolCandidates }
          : prev));
        setExpanded(null);
        setAuditioning((prev) => (prev?.rowId === row.id ? null : prev));
      },
    );
  };

  const unapprove = (row) => act(
    () => mappingAPI.unapprove(row.id),
    row.id,
    () => setRows((prev) => prev.filter((r) => r.id !== row.id)),
  );

  const remove = (row) => act(
    () => mappingAPI.remove(row.id),
    row.id,
    () => setRows((prev) => prev.filter((r) => r.id !== row.id)),
  );

  /**
   * Open the "不是这首" confirmation, having first asked what it would destroy.
   *
   * The impact is fetched rather than assumed: a pool track can be named by
   * more than one mapping, and deleting it takes all of them. That is not
   * visible from the row, so it is read from the server before anything is
   * offered to click.
   */
  const startReject = useCallback(async (row) => {
    if (rejecting?.rowId === row.id) { setRejecting(null); return; }
    setBusy(`reject:${row.id}`);
    setError("");
    try {
      // An unseen row is a pool track with no mapping; its impact comes from
      // the track's own id, through the same cascade.
      const res = row.kind === "imported"
        ? await mappingAPI.poolRejectImpact(row.id)
        : await mappingAPI.rejectImpact(row.id);
      setRejecting({ rowId: row.id, isPool: row.kind === "imported", ...res.data });
    } catch (err) {
      setError(err.response?.data?.error?.message || "无法读取删除影响");
    } finally {
      // Only if still ours — see the note in act().
      setBusy((prev) => (prev === `reject:${row.id}` ? null : prev));
    }
  }, [rejecting]);

  const confirmReject = (row) => act(
    () => (row.kind === "imported"
      ? mappingAPI.poolReject(row.id)
      : mappingAPI.reject(row.id, { deleteTrack: true })),
    row.id,
    () => {
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      setRejecting(null);
      setExpanded(null);
      setAuditioning((prev) => (prev?.rowId === row.id ? null : prev));
      if (row.kind === "imported") {
        setCounts((prev) => ({ ...prev, unseen: Math.max(0, (prev.unseen || 0) - 1) }));
      }
    },
  );

  const claim = (track) => act(
    () => mappingAPI.create({
      gameTitle: gameTitle.trim(),
      gameArtist: gameArtist.trim(),
      source: track.source,
      externalId: track.externalId,
    }),
    track.id,
    () => {
      setRows((prev) => prev.filter((r) => r.id !== track.id));
      setClaimFor(null);
      setGameTitle("");
      setGameArtist("");
    },
  );

  if (authLoading) return <div className="p-8 text-muted">加载中…</div>;

  if (denied) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <div className="rounded-xl border border-border bg-surface p-6">
          <h1 className="mb-2 text-lg font-semibold">没有权限</h1>
          <p className="text-sm text-muted">
            这个页面只对管理员和被授予标注权限的账号开放。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold">唱卡映射审核</h1>
        <p className="mt-1 text-sm text-muted">
          一条映射决定「游戏里显示这个名字时，播放哪一首」。批准后全站生效，
          并且不再被自动搜索覆盖。
        </p>
      </header>

      {(() => {
        // One switch used by every navigation button: stop the audio (the row
        // it belongs to is about to disappear, and music playing over an
        // unrelated tab is disorienting), and drop everything keyed on a row
        // id — the audition especially, or 就是这个 on some later row would
        // commit a track nobody is listening to.
        const switchTo = (key) => {
          audioRef.current?.pause();
          setPlaying(null);
          setLoadedFor(null);
          setAuditioning(null);
          setRejecting(null);
          setBucket(key);
          setExpanded(null);
          setNextCursor(null);
        };
        const group = bucket === "passages" ? "passages" : "songs";
        return (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              {[
                { key: "songs", label: "歌曲" },
                { key: "passages", label: "歌词段落" },
              ].map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => {
                    if (g.key === group) return;
                    switchTo(g.key === "passages" ? "passages" : "pending");
                  }}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                    group === g.key
                      ? "bg-accent text-white"
                      : "bg-surface text-muted hover:text-fg"
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>

            {group === "songs" && (
              <div className="mb-4 flex flex-wrap gap-2">
                {SONG_BUCKETS.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    title={b.hint}
                    onClick={() => switchTo(b.key)}
                    className={`rounded-lg border px-3 py-2 text-sm transition ${
                      bucket === b.key
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border bg-surface text-muted hover:text-fg"
                    }`}
                  >
                    {b.label}
                    <span className="ml-2 rounded bg-black/20 px-1.5 py-0.5 text-xs tabular-nums">
                      {counts[b.key] ?? 0}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        );
      })()}

      {/* 未配置 owns its whole body: its rows are game texts rather than
          mapping rows, it has its own search and its own actions, and it is
          recomputed rather than paged. Everything below is for the other
          three. */}
      {bucket === "unconfigured" && (
        <UnconfiguredPanel
          onCountsChange={(n) => setCounts((prev) => ({ ...prev, unconfigured: n }))}
        />
      )}

      {bucket === "passages" && <PassagePanel />}

      {bucket !== "unconfigured" && bucket !== "passages" && (
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => { e.preventDefault(); setSubmittedQuery(query); }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索歌名或歌手…"
          className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button type="submit" className="rounded-lg border border-border bg-surface px-4 py-2 text-sm hover:border-accent">
          搜索
        </button>
      </form>
      )}

      {/* Only warned about while it is still worth acting on. A banner about
          the QQ connection sat here before, which was wrong twice over: most
          of the page does not need it — library tracks need no credential and
          NetEase ones need a different one — and it shouted at someone who
          might only be reading. The credential is now checked when a specific
          row is played, against that row's own source. */}
      {credential && credential.connected && credential.level === "soon" && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          <span>QQ 音乐连接即将过期</span>
          <a href="/account" className="underline underline-offset-2 hover:opacity-80">去账号页续期</a>
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      {playError && (
        <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          {playError}
        </div>
      )}

      {bucket !== "unconfigured" && loading && rows.length === 0 && <div className="p-6 text-sm text-muted">加载中…</div>}

      {bucket !== "unconfigured" && !loading && rows.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-6 text-sm text-muted">
          {/* The submitted term, not the input: typing without pressing enter
              must not relabel an empty bucket as "no matches". */}
          {submittedQuery ? "没有匹配的结果。" : "这个分类目前是空的。"}
        </div>
      )}

      {/* Two columns once there is room. The panel is tall and narrow, which
          is what lets it show twenty lines of lyrics without the list losing
          its place; on a small screen it drops below instead. */}
      {/* The list gets the larger share, which is the opposite of what the
          cap here first assumed. Reviewing is reading: the question a row asks
          is whether the platform title on top really names the same recording
          as the game title underneath, and that cannot be answered from two
          truncated strings. Titles were losing their tails at 32rem — with the
          buttons on the same line, a 512px row left the text barely 140px.

          The lyric panel takes what is left. It reads perfectly well narrow,
          being short centred lines, so the width is worth more here. */}
      {bucket !== "unconfigured" && bucket !== "passages" && (
      <div className="lg:grid lg:grid-cols-[minmax(0,48rem)_1fr] lg:items-start lg:gap-4">
        <div className="min-w-0">
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.id} className="rounded-lg border border-border bg-surface">
            {/* One line again, which the width now affords. The buttons cannot
                shrink -- pressing the wrong one deletes a recording -- so they
                take their ~340px first and the titles live on the remainder;
                at 32rem that left about 140px and the titles were cut short,
                but at 48rem it leaves roughly 400px, which a Chinese title and
                artist fit into. Two lines per row bought nothing after that
                and cost a third of the rows on screen. */}
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              {/* Expands rather than plays. Deciding on a mapping means reading
                  the lyrics as much as hearing the audio, and starting playback
                  from a collapsed row gave no way to follow along. */}
              <button
                type="button"
                onClick={() => togglePlayer(row)}
                title={selected?.id === row.id ? "收起歌词" : "查看歌词"}
                className="h-7 w-7 shrink-0 rounded-full border border-border text-xs hover:border-accent"
              >
                {selected?.id === row.id ? "▪" : "▸"}
              </button>

              {/* Two lines, one per side of the pairing, because that
                  comparison is the entire review: does the platform track on
                  top really correspond to the game song underneath.

                  They used to share a line, with the source chip in front of
                  the game's own title and artist -- so a row read "QQ 纯真 —"
                  while QQ knew perfectly well the artist was 五月天. The chip
                  names where a mapping resolves to, and putting it in front of
                  the other side's text made it look like a label for it.

                  The platform id stays out of both. It matters to us — it is
                  what playback resolves and what the cache is keyed on — but a
                  reviewer never reads it, and a 14-character mid crowded out
                  the artist beside it. */}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5 overflow-hidden whitespace-nowrap text-[0.82rem] leading-tight">
                  <span className="shrink-0 rounded bg-black/20 px-1 py-px text-[0.62rem] text-muted">
                    {SOURCE_LABEL[row.source] || row.source}
                  </span>
                  <span className="truncate font-medium">
                    {row.platformTitle || row.title}
                    <span className="text-muted"> — {row.platformArtist || "—"}</span>
                  </span>
                  <span className="shrink-0 text-[0.68rem] tabular-nums text-muted">
                    {formatDuration(row.durationSec)}
                  </span>
                </div>

                <div className="mt-px flex items-baseline gap-1.5 overflow-hidden whitespace-nowrap text-[0.68rem] leading-tight text-muted">
                  <span className="shrink-0 rounded bg-black/20 px-1 py-px text-[0.6rem]">QNI</span>
                  {/* 《》 is how 歌 P writes a title and never how 唱卡 does, so
                      a row still carrying them came in through the wrong
                      channel. Stripped for reading; the stored key is
                      untouched. */}
                  <span className="truncate">
                    {String(row.title || "").replace(/^《|》$/g, "")}
                    {row.artist ? ` — ${row.artist}` : ""}
                  </span>
                  {row.matchKind && <span className="shrink-0">· {row.matchKind}</span>}
                  {row.note && <span className="truncate text-yellow-500/80">· {row.note}</span>}
                  {row.approvedBy && <span className="shrink-0">· 由 {row.approvedBy} 确认</span>}
                </div>
              </div>

              <div className="flex shrink-0 gap-1.5">
                {/* Confirming is offered on approved rows too, but only while an
                    alternative is playing. An automatic STRONG match that chose
                    the wrong version arrives already approved, so requiring
                    撤销确认 first would make correcting it a three-step detour. */}
                {row.kind === "mapping" && (!row.approved || auditioning?.rowId === row.id) && (
                  <button
                    type="button"
                    onClick={() => approve(row)}
                    disabled={busy === row.id}
                    className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {/* Says which one it would save. Sending the row's own id
                        while an alternative plays is the mistake this guards. */}
                    {auditioning?.rowId === row.id ? "就用这个版本" : "就是这个"}
                  </button>
                )}
                {row.kind === "mapping" && (
                  <button
                    type="button"
                    onClick={() => startReject(row)}
                    disabled={busy === `reject:${row.id}`}
                    className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    {busy === `reject:${row.id}` ? "…" : "不是这首"}
                  </button>
                )}
                {row.kind === "mapping" && row.approved && (
                  <button
                    type="button"
                    onClick={() => unapprove(row)}
                    disabled={busy === row.id}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-fg disabled:opacity-50"
                  >
                    撤销确认
                  </button>
                )}
                {row.kind === "imported" && (
                  <button
                    type="button"
                    onClick={() => { setClaimFor(claimFor === row.id ? null : row.id); setGameTitle(row.title); setGameArtist(row.artist); }}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs hover:border-accent"
                  >
                    认领
                  </button>
                )}
                {row.kind === "imported" && (
                  <button
                    type="button"
                    onClick={() => startReject(row)}
                    disabled={busy === `reject:${row.id}`}
                    className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    {busy === `reject:${row.id}` ? "…" : "删除"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => toggleExpand(row)}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted hover:text-fg"
                >
                  {expanded === row.id ? "▴" : "▾"}
                </button>
              </div>
            </div>


            {claimFor === row.id && (
              <div className="border-t border-border p-3">
                <p className="mb-2 text-xs text-muted">
                  游戏里显示的歌名和歌手是什么？映射用它作为查询的键。
                </p>
                <div className="flex flex-wrap gap-2">
                  <input
                    value={gameTitle}
                    onChange={(e) => setGameTitle(e.target.value)}
                    placeholder="游戏里的歌名"
                    className="min-w-[10rem] flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                  <input
                    value={gameArtist}
                    onChange={(e) => setGameArtist(e.target.value)}
                    placeholder="游戏里的歌手"
                    className="min-w-[10rem] flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => claim(row)}
                    disabled={!gameTitle.trim() || busy === row.id}
                    className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300 disabled:opacity-40"
                  >
                    建立映射
                  </button>
                </div>
              </div>
            )}

            {/* Alternatives, shown without being asked.
                Only when there is a real choice: a lone candidate is the row
                itself restated, and a list of those would push the next row off
                the screen for nothing. */}
            {row.kind === "mapping" && (row.poolCandidates?.length || 0) > 1 && (
              <div className="border-t border-border/60 px-2.5 py-1.5">
                <ul className="space-y-1">
                  {row.poolCandidates.map((c) => {
                    const key = audioKey(row, c);
                    const isAudition = auditioning?.rowId === row.id
                      && auditioning.candidate.source === c.source
                      && auditioning.candidate.externalId === c.externalId;
                    return (
                      <li
                        key={`${c.source}:${c.externalId}`}
                        className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                          isAudition ? "border-accent/70 bg-accent/5" : "border-border/60"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {c.title} — {c.artist}
                          {/* Candidates are usually the same song twice, so the
                              id and the duration are what tell them apart. */}
                          <span className="ml-2 font-mono text-muted/70">{c.externalId}</span>
                          <span className="ml-2 text-muted">{formatDuration(c.durationSec)}</span>
                          {c.artistMatches && <span className="ml-2 text-emerald-400">歌手吻合</span>}
                          {c.durationMatches && <span className="ml-2 text-emerald-400">时长吻合</span>}
                          {c.current && <span className="ml-2 text-muted">· 当前</span>}
                        </span>
                        {/* Auditions, never commits. Hearing an alternative is
                            how you tell two recordings apart; 就是这个 on the row
                            above is what writes the choice down. */}
                        <button
                          type="button"
                          onClick={() => play(row, c)}
                          disabled={busy === `play:${key}`}
                          className={`shrink-0 rounded border px-2 py-1 disabled:opacity-50 ${
                            isAudition ? "border-accent text-accent" : "border-border hover:border-accent"
                          }`}
                        >
                          {busy === `play:${key}` ? "…" : playing === key ? "暂停" : "试听"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {rejecting?.rowId === row.id && (
              <div className="border-t border-red-500/30 bg-red-500/5 p-3">
                <p className="text-xs text-red-200">
                  确定这首不该留在曲库里？将从曲库彻底删除
                  <span className="mx-1 font-medium">
                    {rejecting.track
                      ? `${rejecting.track.title} — ${rejecting.track.artist}`
                      : "（曲库里已无此条目）"}
                  </span>
                  {rejecting.isPool ? "。" : "并删除这条映射。"}
                </p>
                {/* A pool track keyed on (source, id) can be named by more than
                    one mapping. Those go too, and saying so afterwards would be
                    too late. */}
                {rejecting.otherMappings?.length > 0 && (
                  <p className="mt-1.5 text-xs text-amber-300">
                    ⚠ 另有 {rejecting.otherMappings.length} 条映射指向同一首，会一并删除：
                    {rejecting.otherMappings.slice(0, 4).map((o) => (
                      <span key={o.id} className="ml-1">
                        「{o.title}{o.artist ? ` — ${o.artist}` : ""}」{o.approved ? "（已确认）" : ""}
                      </span>
                    ))}
                    {rejecting.otherMappings.length > 4 && <span className="ml-1">等</span>}
                  </p>
                )}
                <p className="mt-1.5 text-xs text-muted">
                  删除后自动匹配不会再选中它。若之后重新导入同一歌单，它会重新出现。
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setRejecting(null)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-fg"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => confirmReject(row)}
                    disabled={busy === row.id}
                    className="rounded-lg border border-red-500/60 bg-red-500/15 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/25 disabled:opacity-50"
                  >
                    {busy === row.id ? "删除中…" : "确认删除"}
                  </button>
                </div>
              </div>
            )}

            {expanded === row.id && row.kind === "mapping" && (
              <div className="border-t border-border p-3">
                <div className="mb-2 text-xs text-muted">
                  键：{row.titleKey} | {row.artistKey || "（无歌手）"}
                </div>
                {(row.poolCandidates?.length || 0) <= 1 && (
                  <p className="text-xs text-muted">曲库池里没有同名的其他版本可选。</p>
                )}
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => remove(row)}
                    disabled={busy === row.id}
                    className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    只删除这条映射
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {nextCursor && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => load({ append: true, cursor: nextCursor })}
            disabled={loading}
            className="rounded-lg border border-border bg-surface px-5 py-2 text-sm hover:border-accent disabled:opacity-50"
          >
            {loading ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
        </div>

        {/* Sticky so the lyrics stay put while the list scrolls behind them —
            otherwise following along means scrolling back every few lines. */}
        {selected && (
          <div className="mt-4 lg:sticky lg:top-6 lg:mt-0">
            {/* The panel follows whatever this row is actually playing,
                audition included. Comparing against the bare row id would have
                frozen the lyrics the moment an alternative started — the audio
                would play on while the panel showed 0:00 and highlighted
                nothing, which is the one thing the panel exists to do. */}
            <TrackLyricPanel
              row={selected}
              audition={selectedAudition}
              isPlaying={playing === selectedKey}
              current={loadedFor === selectedKey ? progress.current : 0}
              duration={loadedFor === selectedKey ? progress.duration : (selected.durationSec || 0)}
              onTogglePlay={() => play(selected, selectedAudition)}
              onSeekSeconds={seekSeconds}
              onNudge={nudgeSeconds}
              onClose={() => setSelected(null)}
              busy={busy === `play:${selectedKey}`}
              error={playing === selectedKey || loadedFor === selectedKey ? playError : ""}
            />
          </div>
        )}
      </div>
      )}
    </div>
  );
}
