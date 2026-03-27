"use client";

import { useState, useMemo, useEffect, memo } from "react";
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
    speed,
    pitch,
  });

  useEffect(() => {
    if (playFromStartClipId !== clipId) return;
    clearPlayFromStart();
    playFromStart();
  }, [playFromStartClipId, clipId, clearPlayFromStart, playFromStart]);

  const highlightClass = highlighted
    ? "ring-2 ring-amber-400 ring-offset-2 ring-offset-background shadow-amber-400/30 shadow-lg"
    : "";

  // Build speed/pitch meta string like v5
  const metaText = (() => {
    const parts = [];
    if (speed !== 1) parts.push(`${speed}x`);
    if (pitch !== 0) parts.push(`${pitch > 0 ? "+" : ""}${pitch}`);
    return parts.join("  ");
  })();

  return (
    <div
      id={`playerbox-${clipId}`}
      className={`relative overflow-visible rounded-xl border border-border bg-surface shadow-sm transition-all ${highlightClass}`}
    >
      {/* Color tag flags — top right, always editable */}
      <ColorTag
        color={colorTag}
        editable={true}
        onChange={(c) => onUpdate?.(clipId, { colorTag: c })}
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
              onSwap={(newClipId) => onSwap(clipId, newClipId)}
              onNewClip={() => setShowNewClip(true)}
            />
          </div>
        )}

        {/* Lyrics — clean, no background */}
        <LyricsBox
          lyrics={clip.lyrics}
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
            aria-label={isPlaying ? t("pause") : t("play")}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-white shadow-sm transition-all hover:bg-primary-hover hover:scale-105 active:scale-95"
          >
            {isPlaying ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]">
                <rect x="5" y="3" width="4.5" height="18" rx="1" />
                <rect x="14.5" y="3" width="4.5" height="18" rx="1" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px] translate-x-0.5">
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
          <LikeButton playlistId={playlistId} clipId={clipId} />
        </div>

        {/* Edit mode: speed/pitch controls + remove */}
        {editMode && (
          <div className="mt-1.5 flex items-center gap-2">
            <SpeedControl
              speed={speed}
              onChange={(s) => onUpdate?.(clipId, { speed: s })}
            />
            <PitchControl
              pitch={pitch}
              onChange={(p) => onUpdate?.(clipId, { pitch: p })}
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
          onChange={(c) => onUpdate?.(clipId, { comment: c })}
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
})
