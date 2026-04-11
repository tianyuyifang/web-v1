"use client";

const SPEEDS = [0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2, 1.3];

export default function SpeedControl({ speed, onChange }) {
  return (
    <select
      value={speed}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="appearance-none rounded border border-border bg-background px-2 py-0.5 pr-5 text-xs text-theme"
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath fill='%238080a0' d='M0 0l4 5 4-5z'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 6px center" }}
    >
      {SPEEDS.map((s) => (
        <option key={s} value={s}>
          {s}x
        </option>
      ))}
    </select>
  );
}
