"use client";

export default function PitchControl({ pitch, onChange }) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onChange(Math.max(-4, pitch - 1))}
        disabled={pitch <= -4}
        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-theme hover:bg-surface-hover disabled:opacity-30"
      >
        -
      </button>
      <span className="min-w-[2.5rem] text-center text-xs text-muted">
        {pitch > 0 ? `+${pitch}` : pitch === 0 ? "0" : pitch}
      </span>
      <button
        onClick={() => onChange(Math.min(4, pitch + 1))}
        disabled={pitch >= 4}
        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-theme hover:bg-surface-hover disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}
