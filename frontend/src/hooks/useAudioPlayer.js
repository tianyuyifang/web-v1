"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import usePlayerStore from "@/store/playerStore";
import { getAudioBuffer, hasCachedBuffer, getNormGain, getSharedContext } from "@/lib/audioCache";

/**
 * Audio player hook with independent speed and pitch control via SoundTouch DSP.
 *
 * Pipeline: fetch clip → decode AudioBuffer → SoundTouch PitchShifter → GainNode → destination
 *
 * - pitch: semitones (-4 to +4), independent of speed
 * - speed (tempo): 0.5-2.0, independent of pitch
 * - Both can be changed in real-time during playback
 */

export default function useAudioPlayer({
  playerId,
  clipId,
  clipLength,
  clipVersion,
  speed = 1.0,
  pitch = 0,
}) {
  const shifterRef = useRef(null);
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const bufferRef = useRef(null);
  const normGainRef = useRef(1);
  const timerRef = useRef(null);
  const startTimeRef = useRef(0);
  const offsetRef = useRef(0);

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [volume, setVolumeState] = useState(1);

  const activePlayerId = usePlayerStore((s) => s.activePlayerId);
  const setActivePlayer = usePlayerStore((s) => s.setActivePlayer);

  // Check if buffer is already preloaded
  useEffect(() => {
    if (hasCachedBuffer(clipId, clipVersion)) setIsLoaded(true);
  }, [clipId, clipVersion]);

  // Load audio buffer (uses shared cache and shared AudioContext)
  const loadBuffer = useCallback(async () => {
    if (bufferRef.current) return bufferRef.current;

    audioCtxRef.current = getSharedContext();

    const audioBuffer = await getAudioBuffer(clipId, clipVersion);
    bufferRef.current = audioBuffer;
    normGainRef.current = getNormGain(clipId, clipVersion);
    setIsLoaded(true);
    return audioBuffer;
  }, [clipId]);

  // Stop and clean up the current shifter
  const stopShifter = useCallback(() => {
    if (timerRef.current) {
      cancelAnimationFrame(timerRef.current);
      timerRef.current = null;
    }
    if (shifterRef.current) {
      try {
        shifterRef.current.disconnect();
      } catch {
        // already disconnected
      }
      shifterRef.current = null;
    }
  }, []);

  // Time tracking loop
  const startTimeTracking = useCallback((ctx, startOffset, tempoRate) => {
    startTimeRef.current = ctx.currentTime;
    offsetRef.current = startOffset;

    const tick = () => {
      if (!shifterRef.current) return;
      const elapsed = (ctx.currentTime - startTimeRef.current) * tempoRate;
      const time = Math.min(offsetRef.current + elapsed, clipLength);
      setCurrentTime(time);

      if (time >= clipLength) {
        stopShifter();
        setCurrentTime(0);
        offsetRef.current = 0;
        setIsPlaying(false);
        return;
      }

      timerRef.current = requestAnimationFrame(tick);
    };
    timerRef.current = requestAnimationFrame(tick);
  }, [clipLength, stopShifter]);

  // Reset when another player becomes active
  useEffect(() => {
    if (activePlayerId !== playerId && activePlayerId !== null) {
      if (isPlaying) {
        stopShifter();
        setIsPlaying(false);
      }
      offsetRef.current = 0;
      setCurrentTime(0);
    }
  }, [activePlayerId, playerId, isPlaying, stopShifter]);

  // Cleanup on unmount (don't close shared AudioContext)
  useEffect(() => {
    return () => {
      stopShifter();
      audioCtxRef.current = null;
      bufferRef.current = null;
      normGainRef.current = 1;
      gainRef.current = null;
    };
  }, [stopShifter]);

  const play = useCallback(async () => {
    try {
      const buffer = await loadBuffer();
      const ctx = audioCtxRef.current;

      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      // Stop any existing playback
      stopShifter();

      // Import SoundTouch dynamically (it's ESM-friendly)
      const { PitchShifter } = await import(/* webpackChunkName: "soundtouchjs" */ "soundtouchjs");

      // Create gain node for volume
      if (!gainRef.current) {
        gainRef.current = ctx.createGain();
        gainRef.current.connect(ctx.destination);
      }
      gainRef.current.gain.value = volume * normGainRef.current;

      // Create PitchShifter from the current offset position
      const shifter = new PitchShifter(ctx, buffer, 4096, () => {
        // onEnd callback
        stopShifter();
        setCurrentTime(0);
        offsetRef.current = 0;
        setIsPlaying(false);
      });

      shifter.pitchSemitones = pitch;
      shifter.tempo = speed;

      // Seek to offset position
      if (offsetRef.current > 0) {
        shifter.percentagePlayed = offsetRef.current / (buffer.duration || clipLength);
      }

      shifter.connect(gainRef.current);
      shifterRef.current = shifter;

      startTimeTracking(ctx, offsetRef.current, speed);
      setIsPlaying(true);
      setActivePlayer(playerId);
    } catch (err) {
      console.error("Audio play error:", err);
    }
  }, [
    loadBuffer,
    stopShifter,
    startTimeTracking,
    pitch,
    speed,
    volume,
    clipLength,
    playerId,
    setActivePlayer,
  ]);

  const pause = useCallback(() => {
    if (audioCtxRef.current && startTimeRef.current) {
      const elapsed = (audioCtxRef.current.currentTime - startTimeRef.current) * speed;
      offsetRef.current = Math.min(offsetRef.current + elapsed, clipLength);
    }
    stopShifter();
    setIsPlaying(false);
  }, [speed, clipLength, stopShifter]);

  const seek = useCallback(
    (positionInClip) => {
      offsetRef.current = Math.max(0, Math.min(positionInClip, clipLength));
      setCurrentTime(offsetRef.current);

      // If playing, restart from new position
      if (isPlaying && shifterRef.current) {
        play();
      }
    },
    [clipLength, isPlaying, play]
  );

  const setVolume = useCallback((v) => {
    setVolumeState(v);
    if (gainRef.current) {
      gainRef.current.gain.value = v * normGainRef.current;
    }
  }, []);

  const setSpeed = useCallback(
    (s) => {
      if (shifterRef.current) {
        shifterRef.current.tempo = s;
      }
    },
    []
  );

  const playFromStart = useCallback(() => {
    offsetRef.current = 0;
    setCurrentTime(0);
    play();
  }, [play]);

  return {
    play,
    pause,
    seek,
    playFromStart,
    setVolume,
    setSpeed,
    currentTime,
    duration: clipLength,
    isPlaying,
    isLoaded,
    volume,
  };
}
