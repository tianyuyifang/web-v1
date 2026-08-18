"use client";

/**
 * Connect a QQ Music / NetEase account.
 *
 * Two ways in, and both are needed.
 *
 * Scanning is the good one: it is the only path that yields a renewal key, so
 * a scanned connection keeps itself alive while a pasted cookie dies after a
 * few days. But it leans on an endpoint QQ Music's own web player uses rather
 * than a documented one, and endpoints like that disappear without notice — so
 * pasting stays available underneath, and every scan failure points at it.
 *
 * The credential never comes back to this page. The server reports whether an
 * account is connected and what it is worth (VIP or not); the cookie itself
 * stays server-side, because anyone holding it can act as that user on the
 * platform.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { musicSourcesAPI } from "@/lib/api";

const PLATFORMS = [
  {
    key: "qq",
    name: "QQ 音乐",
    supportsQr: true,
    // Written out because "open devtools and copy a header" is not something
    // most people can do from memory.
    pasteHint: "登录 y.qq.com 后按 F12 → Network → 任意请求 → 复制 Cookie 整行",
  },
  {
    key: "netease",
    name: "网易云音乐",
    supportsQr: false,
    pasteHint: "登录 music.163.com 后按 F12 → Application → Cookies → 复制 MUSIC_U",
  },
];

/** "还有 2 天" / "还有 5 小时" — precise enough to act on, no more. */
function formatRemaining(ms) {
  if (ms == null) return null;
  if (ms <= 0) return "已过期";
  const hours = Math.floor(ms / 3600000);
  if (hours >= 24) return `还有 ${Math.floor(hours / 24)} 天`;
  if (hours >= 1) return `还有 ${hours} 小时`;
  return `不到 1 小时`;
}

function StatusLine({ source }) {
  if (!source?.connected) {
    return <span className="text-sm text-muted">未连接</span>;
  }

  // vipType is null until the platform has actually been asked. Saying
  // "connected" without that would imply it works, and a non-VIP account
  // signs in perfectly then fails on most songs.
  const vip = source.vipType == null
    ? { text: "已连接（尚未验证会员状态）", tone: "text-muted" }
    : source.vipType > 0
      ? { text: source.vipType > 1 ? "已连接 · 超级会员" : "已连接 · 会员", tone: "text-emerald-400" }
      : { text: "已连接 · 非会员（多数歌曲无法播放）", tone: "text-amber-400" };

  return (
    <span className={`text-sm ${vip.tone}`}>
      {vip.text}
      {source.nickname ? ` · ${source.nickname}` : ""}
      {/* The membership's own expiry, which is months away and unrelated to the
          login credential's — those are separate clocks and conflating them
          would have the page announce an expiry that is not the one at risk. */}
      {source.vipType > 0 && source.vipExpiresOn ? (
        <span className="text-muted">{` · 会员至 ${source.vipExpiresOn}`}</span>
      ) : null}
    </span>
  );
}

/**
 * Say something before playback starts failing, not after.
 *
 * Without this the only symptom of a dead credential is a song that will not
 * play, with nothing on screen connecting the two. Kept quiet until there is
 * genuinely something to do — a connection with days left says nothing at all.
 */
function ExpiryNotice({ source, onRefresh, busy }) {
  if (!source?.connected) return null;
  const { level, expiresInMs, refreshable } = source;

  // A healthy connection still says how long it has left. Silence here is what
  // made the earlier version confusing: the page looked identical whether the
  // credential had three days left or three minutes, so there was no way to
  // tell a working connection from one about to stop working.
  if (level === "ok") {
    if (expiresInMs == null) return null;
    return (
      <div className="mt-2 text-xs text-muted">
        {`连接${formatRemaining(expiresInMs)}过期`}
        {refreshable ? "，届时自动续期" : "，到期后需重新连接"}
      </div>
    );
  }

  const tone = level === "expired" || level === "urgent"
    ? "border-red-500/40 bg-red-500/10 text-red-300"
    : "border-amber-500/40 bg-amber-500/10 text-amber-300";

  const headline = level === "expired"
    ? "连接已过期，无法播放"
    : `连接${formatRemaining(expiresInMs)}过期`;

  return (
    <div className={`mt-2 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs ${tone}`}>
      <span>{headline}</span>
      {refreshable ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="rounded border border-current px-2 py-0.5 hover:opacity-80 disabled:opacity-50"
        >
          {busy ? "续期中…" : "立即续期"}
        </button>
      ) : (
        // A pasted credential has no refresh key, so renewal is not on offer —
        // saying "renew" and then failing would be worse than saying nothing.
        <span className="opacity-80">手动输入的连接无法续期，请重新扫码</span>
      )}
    </div>
  );
}

export default function MusicSourcesPanel() {
  const [sources, setSources] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");

  const [pasteFor, setPasteFor] = useState(null);
  const [cookie, setCookie] = useState("");

  const [qr, setQr] = useState(null); // { uuid, image }
  const [qrStatus, setQrStatus] = useState("");
  const pollingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await musicSourcesAPI.list();
      const map = {};
      res.data.sources.forEach((s) => { map[s.platform] = s; });
      setSources(map);
    } catch {
      // A failure here is not worth an error banner: the panel simply shows
      // "not connected", which is also what an unconfigured account looks like.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Stop polling if the panel goes away, or the loop keeps running against a
  // QR code nobody can see.
  useEffect(() => () => { pollingRef.current = false; }, []);

  const startQr = useCallback(async (provider = "wechat") => {
    setError("");
    setBusy("qr");
    setQrStatus("");
    try {
      const res = await musicSourcesAPI.createQr(provider);
      setQr({ uuid: res.data.uuid, image: res.data.image, provider });
      /**
       * Hard stop for the polling loop.
       *
       * The loop otherwise ends only on done/expired/refused or an error, and
       * a code that keeps answering "waiting" past its lifetime would poll
       * forever — an unattended tab quietly hitting a login endpoint every two
       * seconds is exactly the pattern that gets an account flagged. QQ Music
       * states the lifetime itself (900s measured); a small margin past it is
       * enough to catch a late scan without running on.
       */
      const deadline = Date.now() + ((res.data.expiresIn || 300) + 30) * 1000;
      setQrStatus("waiting");
      pollingRef.current = true;

      // Poll immediately and keep going: the code expires in a few minutes,
      // and a gap between generating and polling is enough to miss it.
      (async () => {
        while (pollingRef.current) {
          if (Date.now() > deadline) {
            pollingRef.current = false;
            setQrStatus("expired");
            return;
          }
          let res2;
          try {
            res2 = await musicSourcesAPI.pollQr(res.data.uuid, provider);
          } catch (err) {
            if (!pollingRef.current) return;
            setError(err.response?.data?.error?.message || "扫码登录失败，可改用手动输入 Cookie");
            setQr(null);
            return;
          }
          if (!pollingRef.current) return;

          const { status, source } = res2.data;
          setQrStatus(status);

          if (status === "done") {
            setSources((prev) => ({ ...prev, qq: source }));
            setQr(null);
            pollingRef.current = false;
            refresh();
            return;
          }
          if (status === "expired" || status === "refused") {
            pollingRef.current = false;
            return;
          }

          /**
           * WeChat holds each request open for tens of seconds, so its loop
           * paces itself. QQ Music answers at once, and without a wait this is
           * a tight loop against a login endpoint — the surest way to get an
           * account flagged. Placed after the exit checks so it only ever
           * delays a genuine retry, never the scan that just succeeded.
           */
          if (provider === "qqmusic") {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      })();
    } catch (err) {
      const code = err.response?.data?.error?.code;
      setError(code === "QR_SHAPE_CHANGED"
        ? "微信扫码暂时不可用，请使用下方的手动输入 Cookie"
        : err.response?.data?.error?.message || "无法获取二维码");
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const cancelQr = useCallback(() => {
    pollingRef.current = false;
    setQr(null);
    setQrStatus("");
  }, []);

  const savePaste = useCallback(async (platform) => {
    setError("");
    setBusy(platform);
    try {
      const res = await musicSourcesAPI.save(platform, cookie.trim());
      setSources((prev) => ({ ...prev, [platform]: res.data.source }));
      setCookie("");
      setPasteFor(null);
    } catch (err) {
      setError(err.response?.data?.error?.message || "保存失败");
    } finally {
      setBusy(null);
    }
  }, [cookie]);

  const renew = useCallback(async () => {
    setError('');
    setBusy('refresh');
    try {
      const res = await musicSourcesAPI.refresh();
      setSources((prev) => ({ ...prev, qq: res.data.source }));
    } catch (err) {
      setError(err.response?.data?.error?.message || '续期失败，请重新扫码连接');
    } finally {
      setBusy(null);
    }
  }, []);

  const disconnect = useCallback(async (platform) => {
    setBusy(platform);
    try {
      const res = await musicSourcesAPI.clear(platform);
      setSources((prev) => ({ ...prev, [platform]: res.data.source }));
    } catch (err) {
      setError(err.response?.data?.error?.message || "断开失败");
    } finally {
      setBusy(null);
    }
  }, []);

  if (loading) return null;

  return (
    <div className="rounded-xl border border-border bg-surface p-6">
      <h2 className="text-base font-semibold">音乐账号</h2>
      <p className="mt-1 text-sm text-muted">
        连接后可以播放曲库以外的歌曲。凭证加密保存，任何页面都不会显示它。
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="mt-4 space-y-3">
        {PLATFORMS.map((p) => {
          const source = sources[p.key];
          const connected = source?.connected;
          return (
            <div key={p.key} className="rounded-lg border border-border/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="mt-0.5"><StatusLine source={source} /></div>
                  <ExpiryNotice source={source} busy={busy === 'refresh'} onRefresh={renew} />
                  {connected && source.method === "paste" && (
                    <div className="mt-1 text-xs text-amber-400/80">
                      手动输入的凭证约 3 天后失效，届时需要重新连接
                    </div>
                  )}
                  {connected && source.method === "qr" && (
                    <div className="mt-1 text-xs text-muted">扫码连接，可自动续期</div>
                  )}
                </div>

                <div className="flex gap-2">
                  {/* Two buttons, not one with a dropdown: a QQ Music account
                      is tied to whichever of the two it was created with, and
                      scanning with the wrong one silently connects a different,
                      empty account. Naming both up front makes that choice
                      visible instead of hiding it behind a default. */}
                  {p.supportsQr && !qr && (
                    <>
                      <button
                        type="button"
                        onClick={() => startQr("wechat")}
                        disabled={busy === "qr"}
                        className="rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
                      >
                        {busy === "qr" ? "生成中…" : "微信扫码"}
                      </button>
                      <button
                        type="button"
                        onClick={() => startQr("qqmusic")}
                        disabled={busy === "qr"}
                        className="rounded-lg border border-primary px-3 py-1.5 text-sm text-primary hover:bg-primary/10 disabled:opacity-50"
                      >
                        QQ音乐APP扫码
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => { setPasteFor(pasteFor === p.key ? null : p.key); setCookie(""); }}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
                  >
                    {p.supportsQr ? "手动输入 Cookie" : connected ? "重新连接" : "连接"}
                  </button>
                  {connected && (
                    <button
                      type="button"
                      onClick={() => disconnect(p.key)}
                      disabled={busy === p.key}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-red-300 disabled:opacity-50"
                    >
                      断开
                    </button>
                  )}
                </div>
              </div>

              {p.supportsQr && qr && (
                <div className="mt-4 flex flex-col items-center gap-3 rounded-lg border border-border/60 bg-bg/50 p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={qr.image}
                    alt={qr.provider === "qqmusic" ? "QQ音乐APP扫码登录" : "微信扫码登录"}
                    className="h-48 w-48 rounded bg-white p-2"
                  />
                  <p className="text-sm text-muted">
                    {qrStatus === "scanned"
                      ? "已扫描，请在手机上确认"
                      : qrStatus === "expired"
                        ? "二维码已过期，请重新生成"
                        : qrStatus === "refused"
                          ? "已取消授权"
                          : qr.provider === "qqmusic"
                            ? "请用 QQ 音乐 APP 扫描二维码"
                            : "请用微信扫描二维码"}
                  </p>
                  {/* Said plainly, because the failure mode is silent: the wrong
                      app connects a real but empty account rather than erroring. */}
                  <p className="text-xs text-muted/80">
                    两种方式都可以，用你手机上已登录该账号的那个 APP 扫
                  </p>
                  <div className="flex gap-2">
                    {(qrStatus === "expired" || qrStatus === "refused") && (
                      <button type="button" onClick={() => startQr(qr.provider)} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-primary">
                        重新生成
                      </button>
                    )}
                    <button type="button" onClick={cancelQr} className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg">
                      取消
                    </button>
                  </div>
                </div>
              )}

              {pasteFor === p.key && (
                <div className="mt-4 space-y-2">
                  <p className="text-xs text-muted">{p.pasteHint}</p>
                  <textarea
                    value={cookie}
                    onChange={(e) => setCookie(e.target.value)}
                    rows={3}
                    placeholder="在此输入 Cookie…"
                    className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => { setPasteFor(null); setCookie(""); }}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => savePaste(p.key)}
                      disabled={!cookie.trim() || busy === p.key}
                      className="rounded-lg border border-primary bg-primary px-4 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-40"
                    >
                      {busy === p.key ? "保存中…" : "保存"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
