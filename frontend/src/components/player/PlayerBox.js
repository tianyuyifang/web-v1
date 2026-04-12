"use client";

import { useState, useMemo, useEffect, useCallback, useRef, memo } from "react";
import { createPortal } from "react-dom";
import useAudioPlayer from "@/hooks/useAudioPlayer";
import usePlayerStore from "@/store/playerStore";
import ProgressBar from "./ProgressBar";
import VolumeControl from "./VolumeControl";
import SpeedControl from "./SpeedControl";
import PitchControl from "./PitchControl";
import LyricsBox from "./LyricsBox";
import LikeButton from "./LikeButton";
import ColorTag from "./ColorTag";
import ClipComment from "./ClipComment";
import ClipSwitcher from "./ClipSwitcher";
import AddClipModal from "@/components/playlist/AddClipModal";
import { useLanguage } from "@/components/layout/LanguageProvider";
import {
  enqueueVisible,
  enqueueHover,
  enqueueNeighborhood,
} from "@/lib/preloadScheduler";

const VIEWPORT_DWELL_MS = 500;
const NEIGHBORHOOD_COUNT = 8;

export default memo(function PlayerBox({
  playlistClip,
  playlistId,
  editMode,
  highlighted,
  onUpdate,
  onRemove,
  onSwap,
  position,
  totalClips,
  onMove,
  allClips,
  clipIndex,
  collapsed,
  onToggleExpand,
}) {
  const { t } = useLanguage();
  const [showNewClip, setShowNewClip] = useState(false);
  const { clipId, speed, pitch, colorTag, comment, clip } = playlistClip;
  const { song } = clip;

  const playerId = `${playlistId}-${clipId}`;

  const playFromStartClipId = usePlayerStore((s) => s.playFromStartClipId);
  const clearPlayFromStart = usePlayerStore((s) => s.clearPlayFromStart);

  const {
    play,
    pause,
    seek,
    playFromStart,
    setVolume,
    setSpeed,
    currentTime,
    duration,
    isPlaying,
    volume,
  } = useAudioPlayer({
    playerId,
    clipId,
    clipLength: clip.length,
    clipVersion: clip.version,
    speed,
    pitch,
  });

  useEffect(() => {
    if (playFromStartClipId !== clipId) return;
    clearPlayFromStart();
    playFromStart();
  }, [playFromStartClipId, clipId, clearPlayFromStart, playFromStart]);

  // --- Preload scheduler wiring ---

  // Viewport preload: when the card is continuously visible for 500ms,
  // enqueue its clip at low priority. Fast scrolling triggers nothing.
  const containerRef = useRef(null);
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    let dwellTimer = null;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          dwellTimer = setTimeout(() => {
            enqueueVisible(clipId, clip.version);
          }, VIEWPORT_DWELL_MS);
        } else if (dwellTimer) {
          clearTimeout(dwellTimer);
          dwellTimer = null;
        }
      },
      { threshold: 0.5 }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (dwellTimer) clearTimeout(dwellTimer);
    };
  }, [clipId, clip.version]);

  // Neighborhood preload: when this clip starts playing, queue the next N
  // clips in the playlist (if the parent provided the clip list + index).
  useEffect(() => {
    if (!isPlaying || !Array.isArray(allClips) || clipIndex == null) return;
    enqueueNeighborhood(allClips, clipIndex, NEIGHBORHOOD_COUNT);
  }, [isPlaying, allClips, clipIndex]);

  // Hover preload: fire on mouse enter over the play button.
  const handlePlayButtonHover = useCallback(() => {
    enqueueHover(clipId, clip.version);
  }, [clipId, clip.version]);

  const highlightClass = (highlighted || isPlaying)
    ? "ring-2 ring-inset shadow-lg dark:ring-[#8D8D94] dark:shadow-[#8D8D94]/20 ring-amber-400 shadow-amber-400/30"
    : "";

  // Stable callbacks for memoized children
  const handleColorTagChange = useCallback((c) => onUpdate?.(clipId, { colorTag: c }), [clipId, onUpdate]);
  const handleSpeedChange = useCallback((s) => onUpdate?.(clipId, { speed: s }), [clipId, onUpdate]);
  const handlePitchChange = useCallback((p) => onUpdate?.(clipId, { pitch: p }), [clipId, onUpdate]);
  const handleCommentChange = useCallback((c) => onUpdate?.(clipId, { comment: c }), [clipId, onUpdate]);
  const handleSwap = useCallback((newClipId) => onSwap(clipId, newClipId), [clipId, onSwap]);

  // Build speed/pitch meta string like v5
  const metaText = (() => {
    const parts = [];
    if (speed !== 1) parts.push(`${speed}x`);
    if (pitch !== 0) parts.push(`${pitch > 0 ? "+" : ""}${pitch}`);
    return parts.join("  ");
  })();

  // --- Phone collapsed view (below sm) ---
  const phoneCollapsedView = collapsed ? (
    <div
      onClick={() => onToggleExpand?.(clipId)}
      className="flex cursor-pointer items-center gap-1.5 border-b border-border/50 px-2 py-[3px] transition-colors hover:bg-surface-hover sm:hidden"
    >
      {position != null && (
        <span className="w-5 shrink-0 text-right text-xs text-muted">{position}.</span>
      )}
      {colorTag && (
        <div className="flex shrink-0 gap-0.5">
          {colorTag.split("|").filter(Boolean).map((c) => (
            <div key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />
          ))}
        </div>
      )}
      <span className="min-w-0 flex-1 truncate">
        <span className="text-xs font-medium text-theme">{song.title}</span>
        <span className="ml-1.5 text-[11px] text-muted">{song.artist.replace(/_/g, "/")}</span>
      </span>
      <div onClick={(e) => e.stopPropagation()} className="shrink-0 [&_button]:h-5 [&_button]:w-5 [&_button]:text-sm">
        <LikeButton playlistId={playlistId} clipId={clipId} fontSize={14} />
      </div>
    </div>
  ) : null;

  // --- Phone expanded view (below sm) ---
  const phoneExpandedView = collapsed ? null : (
    <div
      className={`relative border-b border-border bg-surface transition-all sm:hidden ${highlightClass}`}
    >
      {/* Header row */}
      <div
        onClick={() => !isPlaying && onToggleExpand?.(clipId)}
        className={`flex items-center gap-2 px-3 py-2 ${!isPlaying ? "cursor-pointer" : ""}`}
      >
        {position != null && (
          <span className="w-6 shrink-0 text-right text-xs text-muted">{position}.</span>
        )}
        {colorTag && (
          <div className="flex shrink-0 gap-0.5 self-stretch">
            {colorTag.split("|").filter(Boolean).map((c) => (
              <div key={c} className="w-[3px] rounded-full" style={{ background: c }} />
            ))}
          </div>
        )}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-sm font-medium text-theme">{song.title}</span>
          <span className="ml-2 text-xs text-muted">{song.artist.replace(/_/g, "/")}</span>
        </span>
      </div>

      {/* Body: lyrics left, controls right */}
      <div className="flex gap-2 px-3 pb-3">
        {/* Left: lyrics + comment */}
        <div
          className={`min-w-0 flex-1 ${!isPlaying ? "cursor-pointer" : ""}`}
          onClick={(e) => {
            // Collapse on click unless currently playing, or clicking interactive elements
            if (isPlaying) return;
            const tag = e.target.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
            onToggleExpand?.(clipId);
          }}
        >
          <div className="text-xs">
            <LyricsBox
              clipId={clipId}
              clipVersion={clip.version}
              currentTime={currentTime}
              clipStart={0}
            />
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <ClipComment
              comment={comment}
              onChange={handleCommentChange}
              editable
            />
          </div>
        </div>

        {/* Right: 2x2 grid of controls */}
        <div className="grid w-20 shrink-0 grid-cols-2 gap-2">
          {/* Play/pause */}
          <button
            onClick={isPlaying ? pause : play}
            onMouseEnter={handlePlayButtonHover}
            aria-label={isPlaying ? t("pause") : t("play")}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-white shadow-sm active:scale-95"
          >
            {isPlaying ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                <rect x="5" y="3" width="4.5" height="18" rx="1" />
                <rect x="14.5" y="3" width="4.5" height="18" rx="1" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 translate-x-0.5">
                <polygon points="5,2 21,12 5,22" />
              </svg>
            )}
          </button>

          {/* Replay */}
          <button
            onClick={playFromStart}
            aria-label={t("replay")}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted active:text-primary"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>

          {/* Color tag */}
          <div className="flex h-9 w-9 items-center justify-center">
            <ColorTag
              color={colorTag}
              editable={true}
              onChange={handleColorTagChange}
            />
          </div>

          {/* Like */}
          <div className="flex h-9 w-9 items-center justify-center [&_button]:h-9 [&_button]:w-9">
            <LikeButton playlistId={playlistId} clipId={clipId} fontSize={18} />
          </div>
        </div>
      </div>

      {/* Edit mode controls */}
      {editMode && (
        <div className="flex items-center gap-2 border-t border-border/50 px-3 py-2">
          <SpeedControl speed={speed} onChange={handleSpeedChange} />
          <PitchControl pitch={pitch} onChange={handlePitchChange} />
          {onRemove && (
            <button
              onClick={() => onRemove(clipId)}
              className="ml-auto text-xs font-medium text-red-400"
            >
              {t("remove")}
            </button>
          )}
        </div>
      )}
    </div>
  );

  // --- Desktop view (sm and above) ---
  const desktopView = (
    <div
      ref={containerRef}
      id={`playerbox-${clipId}`}
      className={`relative hidden overflow-visible rounded-xl border border-border bg-surface shadow-sm transition-all sm:block ${highlightClass}`}
    >
      {/* Color tag flags — top right, always editable */}
      <ColorTag
        color={colorTag}
        editable={true}
        onChange={handleColorTagChange}
      />

      <div className="px-4 pb-3 pt-4">
        {/* Position number / move-to input */}
        {position != null && (
          <div className="mb-1.5 flex items-center gap-1 text-xs text-muted">
            {editMode && onMove ? (
              <input
                type="number"
                defaultValue={position}
                min={1}
                max={totalClips || 999}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const target = parseInt(e.target.value, 10);
                    if (target >= 1 && target !== position) {
                      onMove(playlistClip.clipId, position - 1, target - 1);
                    }
                    e.target.blur();
                  }
                }}
                onBlur={(e) => {
                  const target = parseInt(e.target.value, 10);
                  if (target >= 1 && target !== position) {
                    onMove(playlistClip.clipId, position - 1, target - 1);
                  }
                }}
                className="w-10 rounded border border-border bg-background px-1 py-0.5 text-center text-xs text-theme focus:border-primary focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            ) : (
              <span>{position}.</span>
            )}
          </div>
        )}

        {/* Title row: title + artist on same line */}
        <div className="mb-2.5 flex min-w-0 items-baseline gap-2 overflow-hidden pr-8">
          <h3 className="shrink-0 text-lg font-semibold leading-tight" style={{ color: "var(--text)" }}>
            {song.title}
          </h3>
          <span className="min-w-0 truncate text-xs text-muted">{song.artist.replace(/_/g, "/")}</span>
        </div>

        {/* Clip switcher in edit mode */}
        {editMode && onSwap && (
          <div className="mb-2">
            <ClipSwitcher
              songId={song.id}
              currentClipId={clipId}
              onSwap={handleSwap}
              onNewClip={() => setShowNewClip(true)}
            />
          </div>
        )}

        {/* Lyrics — clean, no background */}
        <LyricsBox
          clipId={clipId}
          clipVersion={clip.version}
          currentTime={currentTime}
          clipStart={0}
        />

        {/* Progress bar */}
        <ProgressBar
          currentTime={currentTime}
          duration={duration}
          onSeek={seek}
        />

        {/* Controls row */}
        <div className="mt-2.5 flex items-center">
          {/* Play button */}
          <button
            onClick={isPlaying ? pause : play}
            onMouseEnter={handlePlayButtonHover}
            aria-label={isPlaying ? t("pause") : t("play")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-white shadow-sm transition-all hover:bg-primary-hover hover:scale-105 active:scale-95"
          >
            {isPlaying ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-[16px] w-[16px]">
                <rect x="5" y="3" width="4.5" height="18" rx="1" />
                <rect x="14.5" y="3" width="4.5" height="18" rx="1" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-[16px] w-[16px] translate-x-0.5">
                <polygon points="5,2 21,12 5,22" />
              </svg>
            )}
          </button>

          {/* Replay button */}
          <button
            onClick={playFromStart}
            aria-label={t("replay")}
            className="ml-2.5 flex shrink-0 items-center text-muted transition-all hover:text-primary hover:-rotate-[60deg]"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px]">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>

          {/* Volume */}
          <div className="ml-2.5">
            <VolumeControl volume={volume} onChange={setVolume} />
          </div>

          {/* Speed/pitch meta */}
          {metaText && (
            <span className="ml-2 text-xs text-muted">{metaText}</span>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Like button */}
          <LikeButton playlistId={playlistId} clipId={clipId} fontSize={26} />
        </div>

        {/* Edit mode: speed/pitch controls + remove */}
        {editMode && (
          <div className="mt-1.5 flex items-center gap-2">
            <SpeedControl
              speed={speed}
              onChange={handleSpeedChange}
            />
            <PitchControl
              pitch={pitch}
              onChange={handlePitchChange}
            />
            {onRemove && (
              <button
                onClick={() => onRemove(clipId)}
                className="ml-auto text-xs font-medium text-red-400 transition-colors hover:text-red-300"
              >
                {t("remove")}
              </button>
            )}
          </div>
        )}

        {/* Comment — editable in both modes */}
        <ClipComment
          comment={comment}
          onChange={handleCommentChange}
          editable
        />
      </div>

      {/* New clip modal */}
      {showNewClip && createPortal(
        <AddClipModal
          playlistId={playlistId}
          initialSong={song}
          onClose={() => setShowNewClip(false)}
          onClipSelected={(newClipId) => {
            setShowNewClip(false);
            onSwap(clipId, newClipId);
          }}
        />,
        document.body
      )}
    </div>
  );

  return (
    <>
      {phoneCollapsedView}
      {phoneExpandedView}
      {desktopView}
    </>
  );
})
