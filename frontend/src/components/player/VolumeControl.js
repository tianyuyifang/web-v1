"use client";

import { useState } from "react";

export default function VolumeControl({ volume, onChange }) {
  const [muted, setMuted] = useState(false);
  const [prevVolume, setPrevVolume] = useState(volume);

  const toggleMute = () => {
    if (muted) {
      onChange(prevVolume);
      setMuted(false);
    } else {
      setPrevVolume(volume);
      onChange(0);
      setMuted(true);
    }
  };

  const handleChange = (e) => {
    const v = parseFloat(e.target.value);
    onChange(v);
    if (v > 0) setMuted(false);
  };

  const isMuted = muted || volume === 0;

  return (
    <div className="flex items-center gap-1.5">
      <button onClick={toggleMute} className="shrink-0 text-muted transition-colors hover:text-theme">
        {isMuted ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M9.547 3.062A.75.75 0 0 1 10 3.75v12.5a.75.75 0 0 1-1.264.546L4.703 13H3.167a.75.75 0 0 1-.7-.48A6.985 6.985 0 0 1 2 10c0-.887.165-1.737.468-2.52a.75.75 0 0 1 .699-.48h1.536l4.033-3.796a.75.75 0 0 1 .811-.142ZM13.78 7.22a.75.75 0 1 0-1.06 1.06L14.44 10l-1.72 1.72a.75.75 0 0 0 1.06 1.06L15.5 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L16.56 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L15.5 8.94l-1.72-1.72Z" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M9.547 3.062A.75.75 0 0 1 10 3.75v12.5a.75.75 0 0 1-1.264.546L4.703 13H3.167a.75.75 0 0 1-.7-.48A6.985 6.985 0 0 1 2 10c0-.887.165-1.737.468-2.52a.75.75 0 0 1 .699-.48h1.536l4.033-3.796a.75.75 0 0 1 .811-.142ZM12.53 6.22a.75.75 0 0 1 1.06 0 6 6 0 0 1 0 7.56.75.75 0 0 1-1.06-1.06 4.5 4.5 0 0 0 0-5.44.75.75 0 0 1 0-1.06Z" />
          </svg>
        )}
      </button>
      <div className="relative h-1 w-10 cursor-pointer rounded-full bg-border"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          handleChange({ target: { value: (e.clientX - rect.left) / rect.width } });
        }}
      >
        <div className="absolute left-0 top-0 h-full rounded-full bg-primary" style={{ width: `${(isMuted ? 0 : volume) * 100}%` }} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={isMuted ? 0 : volume}
          onChange={handleChange}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
    </div>
  );
}
