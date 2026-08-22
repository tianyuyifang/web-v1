"use client";

/**
 * Connection status in the nav bar.
 *
 * The capture client runs inside an emulator the user is not looking at — they
 * are looking at the game — so the only place its health can surface is here.
 * A dot rather than a panel: the status is worth glancing at constantly, the
 * controls behind it are worth touching once a game.
 *
 * It also answers the question that the split between connection and
 * destination created: "it says connected, but connected to what?" So the
 * label names where captures are going, not just that a link exists.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import useCaptureStore from "@/store/captureStore";

/** Matches the server's staleness window, so the dot and the API agree. */
const POLL_MS = 15000;

/**
 * Green means captures are actually landing somewhere, not merely that the
 * client is breathing.
 *
 * These were the same colour, and the difference is the whole failure this
 * indicator exists to show: a connection with no destination heartbeats
 * exactly like a working one, so the dot went green while every capture was
 * dropped as no_target. The user watched a green light through a whole game,
 * tagged nothing, and reasonably concluded the client was broken.
 *
 * The split is the one Kubernetes draws between liveness and readiness for the
 * same reason -- a process can be running and still unable to make progress,
 * and the two failures need different responses. Amber here means "the link is
 * fine, you have not aimed it yet", which is a thing the user can fix in one
 * click, and green is reserved for end to end.
 */
function dotClass(connection) {
  if (!connection) return "bg-white/25";
  if (connection.client === "stale") return "bg-yellow-500";
  if (connection.client !== "connected") return "bg-white/40";
  return connection.target === "none" ? "bg-orange-500" : "bg-green-500";
}

function statusText(connection) {
  if (!connection) return "未连接";
  if (connection.client === "stale") return "客户端无响应";
  if (connection.client === "waiting") return "等待客户端";
  if (connection.target === "none") return "未选目标";
  return "已连接";
}

/** Where captures are going right now, in the fewest words that are still true. */
function targetText(connection) {
  if (!connection) return null;
  if (connection.target === "live") return "唱卡";
  if (connection.target === "playlist") {
    return connection.playlist?.name ? `《${connection.playlist.name}》` : "歌单";
  }
  return "未开始";
}

function relative(iso) {
  if (!iso) return "从未";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "从未";
  if (diff < 60_000) return "刚刚";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

export default function CaptureIndicator() {
  const { connection, refresh, connect, stop, disconnect, loading, error } =
    useCaptureStore();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Close on an outside click, the way every other popover on the web behaves.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const copyCode = useCallback(async () => {
    const code = connection?.pairCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access is often refused; the code is on screen to type anyway.
    }
  }, [connection]);

  const target = targetText(connection);

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="自动打标连接"
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-theme"
      >
        <span className={`inline-block h-2 w-2 rounded-full ${dotClass(connection)}`} />
        <span className="hidden lg:inline">{statusText(connection)}</span>
        {/* Named in both states, including "未开始".

            This used to hide itself when the target was none, on the reasoning
            that "已连接 · 未开始" reads as a fault on a fresh connection. It
            does -- but it *is* one by the time a game is running, and hiding it
            meant the label was present exactly when things worked and absent
            exactly when they did not. The one moment it had something worth
            saying was the moment it said nothing. */}
        {connection && (
          <span className="hidden max-w-[10rem] truncate lg:inline text-muted/70">
            · {target}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-64 rounded-lg border border-border bg-surface p-3 shadow-lg">
          <div className="mb-2 flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${dotClass(connection)}`} />
            <span className="text-sm">{statusText(connection)}</span>
          </div>

          {error && <div className="mb-2 text-xs text-red-400">{error}</div>}

          {!connection ? (
            <>
              <p className="mb-2 text-xs text-muted">
                连接一次即可，之后换歌单或切唱卡都不用再输。
              </p>
              <button
                type="button"
                onClick={connect}
                disabled={loading}
                className="w-full rounded bg-accent px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40"
              >
                {loading ? "…" : "连接"}
              </button>
            </>
          ) : (
            <>
              {/* The code is the only thing here that is useless once used, so
                  it shows only while it can still be redeemed. */}
              {connection.pairCode && connection.client !== "connected" && (
                <div className="mb-2 rounded bg-black/20 px-2 py-1.5">
                  <div className="text-[0.65rem] text-muted">在客户端输入配对码</div>
                  <button
                    type="button"
                    onClick={copyCode}
                    title="点击复制"
                    className="font-mono text-xl tracking-widest hover:text-accent"
                  >
                    {connection.pairCode}
                  </button>
                  {copied && <span className="ml-2 text-[0.65rem] text-accent">已复制</span>}
                </div>
              )}

              <dl className="mb-2 space-y-1 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">投递到</dt>
                  <dd className="min-w-0 truncate">{target}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">最后接收</dt>
                  <dd>{relative(connection.lastSeenAt)}</dd>
                </div>
              </dl>

              {/* Says why nothing is arriving, at the moment the user has come
                  looking for exactly that. */}
              {connection.target === "none" && connection.client === "connected" && (
                <p className="mb-2 text-[0.68rem] text-muted">
                  已连接，但还没选择投递目标 —— 去歌单点「自动打标」或去唱卡页点「开始识别」。
                </p>
              )}

              <div className="flex gap-2">
                {connection.target !== "none" && (
                  <button
                    type="button"
                    onClick={stop}
                    className="flex-1 rounded border border-border px-2 py-1 text-xs text-muted hover:text-fg"
                  >
                    停止投递
                  </button>
                )}
                <button
                  type="button"
                  onClick={disconnect}
                  className="flex-1 rounded border border-border px-2 py-1 text-xs text-muted hover:text-red-400"
                >
                  断开
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
