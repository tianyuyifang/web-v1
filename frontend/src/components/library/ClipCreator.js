"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { clipsAPI, songsAPI, getStreamUrl } from "@/lib/api";
import { formatDuration } from "@/lib/utils";
import { parseLRC, getActiveLyricIndex } from "@/lib/lrc";
import VolumeControl from "@/components/player/VolumeControl";
import { useLanguage } from "@/components/layout/LanguageProvider";

export default function ClipCreator({ song, onClose, onClipCreated }) {
  const { t } = useLanguage();
  const length = 20;
  const [start, setStart] = useState(0);
  const [currentTime, setCurrentTime] = useState(0); // absolute position in song
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(song.duration || 0);
  const [volume, setVolume] = useState(1);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [lyrics, setLyrics] = useState(song.lyrics || null);
  const audioRef = useRef(null);
  const lyricsContainerRef = useRef(null);

  // Fetch lyrics if not provided (e.g. from playlist detail which omits them)
  useEffect(() => {
    if (song.lyrics != null) return;
    songsAPI.getById(song.id).then((res) => {
      setLyrics(res.data.lyrics || null);
    }).catch(() => {});
  }, [song.id, song.lyrics]);

  const parsed = useMemo(() => parseLRC(lyrics), [lyrics]);
  const activeIndex = getActiveLyricIndex(parsed, currentTime);

  // Auto-scroll active lyric line within container
  useEffect(() => {
    if (activeIndex < 0 || !lyricsContainerRef.current) return;
    const activeLine = lyricsContainerRef.current.children[activeIndex];
    if (activeLine) {
      const container = lyricsContainerRef.current;
      const top = activeLine.offsetTop - container.offsetTop - container.clientHeight / 2 + activeLine.clientHeight / 2;
      container.scrollTo({ top, behavior: "smooth" });
    }
  }, [activeIndex]);

  // Set up audio element once
  useEffect(() => {
    const audio = new Audio(getStreamUrl(song.id));
    audio.preload = "metadata";
    audioRef.current = audio;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onEnded = () => setIsPlaying(false);

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.pause();
      audio.src = "";
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
    };
  }, [song.id]);

  // Keyboard: space = toggle play, left/right = seek ±2s
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      const audio = audioRef.current;
      if (!audio) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (audio.paused) {
          audio.play().catch(() => {});
          setIsPlaying(true);
        } else {
          audio.pause();
          setIsPlaying(false);
        }
      } else if (e.code === "ArrowLeft" || e.code === "KeyA") {
        e.preventDefault();
        const t = Math.max(0, Math.floor(audio.currentTime) - 1);
        audio.currentTime = t;
        setCurrentTime(t);
      } else if (e.code === "ArrowRight" || e.code === "KeyD") {
        e.preventDefault();
        const t = Math.min(audio.duration || 0, Math.floor(audio.currentTime) + 1);
        audio.currentTime = t;
        setCurrentTime(t);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [isPlaying]);

  const handleSeek = useCallback((e) => {
    const t = parseFloat(e.target.value);
    if (audioRef.current) audioRef.current.currentTime = t;
    setCurrentTime(t);
  }, []);

  const handleSetStart = useCallback(() => {
    setStart(Math.floor(currentTime));
  }, [currentTime]);

  const handleCreate = async () => {
    setCreating(true);
    setError("");
    try {
      const res = await clipsAPI.create({ songId: song.id, start, length });
      onClipCreated(res.data);
    } catch (err) {
      setError(err.response?.data?.message || t("createClipFailed"));
    } finally {
      setCreating(false);
    }
  };


  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-theme">
          {song.title}
          <span className="ml-2 font-normal text-muted">{song.artist}</span>
        </h3>
        {onClose && (
          <button onClick={onClose} className="text-xs text-muted hover:text-theme">
            {t("returnButton")}
          </button>
        )}
      </div>

      {/* Rolling lyrics */}
      <div
        ref={lyricsContainerRef}
        className="h-48 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2 text-xs leading-6"
      >
        {parsed.length === 0 ? (
          <p className="flex h-full items-center justify-center text-muted">{t("noLyrics")}</p>
        ) : (
          parsed.map((line, i) => (
            <p
              key={i}
              onClick={() => {
                if (audioRef.current) {
                  audioRef.current.currentTime = line.time;
                  setCurrentTime(line.time);
                  audioRef.current.play().catch(() => {});
                  setIsPlaying(true);
                }
              }}
              className={`cursor-pointer hover:text-theme ${i === activeIndex ? "font-semibold text-primary" : "text-muted"}`}
            >
              {line.text}
            </p>
          ))
        )}
      </div>

      {/* Playback progress across full song */}
      <div>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.5}
          value={currentTime}
          onChange={handleSeek}
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-slider-track accent-primary"
        />
        <div className="flex justify-between text-xs text-muted">
          <span>{formatDuration(currentTime)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={togglePlay}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white hover:bg-primary-hover"
        >
          {isPlaying ? "⏸" : "▶"}
        </button>

        <button
          onClick={handleSetStart}
          className="rounded-lg border border-border bg-surface px-3 py-1 text-xs text-theme hover:bg-surface-hover"
        >
          {t("setStartHere")}
        </button>

        <span className="text-xs text-muted">
          {t("clipRange")} {formatDuration(start)} → {formatDuration(start + length)}
        </span>

        <div className="ml-auto">
        <VolumeControl
          volume={volume}
          onChange={(v) => {
            setVolume(v);
            if (audioRef.current) audioRef.current.volume = v;
          }}
        />
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Action buttons */}
      <div className="flex gap-2 border-t border-border pt-3">
        <button
          onClick={handleCreate}
          disabled={creating}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {creating ? t("adding") : t("addToList")}
        </button>
      </div>
    </div>
  );
}
