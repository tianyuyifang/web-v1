"use client";

/**
 * The heart on a platform song. Same look and feel as the playlist page's
 * LikeButton -- round, ♡/♥, red when lit -- copied rather than imported: that
 * component is bound to our own likes table (useLikes), and giving it a second
 * mode would be a change to a component every playlist page renders.
 *
 * Pressing a lit heart unlikes. That is the user's own finger on their own
 * favourites, which is a different thing from the capture path: captures only
 * ever add, and never come through here.
 */
export default function PlatformLikeButton({ liked, busy = false, onToggle, fontSize }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      className={`flex h-10 w-10 items-center justify-center rounded-full text-2xl transition-colors hover:bg-surface-hover disabled:opacity-50 ${
        liked ? "text-red-500" : "text-muted hover:text-red-400"
      }`}
      style={fontSize ? { fontSize } : undefined}
      aria-label={liked ? "取消点赞" : "点赞"}
      title={liked ? "取消点赞" : "点赞"}
    >
      {liked ? "♥" : "♡"}
    </button>
  );
}
