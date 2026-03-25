"use client";

export default function PlaylistError({ error, reset }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <p className="text-sm text-muted">Something went wrong loading this playlist.</p>
      <button
        onClick={reset}
        className="rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary-hover"
      >
        Try again
      </button>
    </div>
  );
}
