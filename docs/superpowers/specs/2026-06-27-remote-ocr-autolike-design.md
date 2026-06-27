# Auto-Like from On-Screen OCR — Design

**Date:** 2026-06-27
**Status:** Approved (design), pending implementation plan
**Area:** new `POST /api/remote/like` endpoint + a Windows PC OCR watcher script

## Problem

User runs an Android **music game in an emulator (BlueStacks/LDPlayer/Mumu) on a
Windows PC**, and browses this website on the same PC. They want song titles shown
in the game to be **automatically captured and "liked"** in a chosen playlist —
hands-free, continuously — with the website's playlist view updating live.

## Why this shape (and why PC, not phone)

A web page cannot read pixels from another app, and **iOS cannot run truly
hands-free continuous screen capture** from a Shortcut (no-tap looping while
inside another app is blocked). On a **Windows PC there is no such restriction**:
a desktop program can screen-grab a region on a timer with zero interaction.
Running the game in an **Android emulator on the PC** therefore makes fully
automatic capture achievable.

Split of work:
- **Capture + OCR**: a small **Python watcher script on Windows** (screen-grab a
  region → OCR → POST). This is where the auto-capture lives.
- **Backend**: one small endpoint that matches the text to a clip and likes it.
- **Live PC update**: **already exists** — the per-playlist likes SSE.

The capture host is decoupled from the backend: the endpoint accepts
`{ playlistId, text }` from any authenticated client, so an iOS Shortcut or
Android Tasker could drive the same endpoint later (documented as alternates).

## Decisions

- Capture host (v1): **Windows Python watcher** against an Android emulator window.
- OCR engine: **PaddleOCR** (best Chinese accuracy; heavier install, model
  download). Tesseract+chi_sim noted as a lighter swap.
- Action: **auto-like the best title match** within **one chosen playlist**.
- Like semantics: **like-only / idempotent** — re-seeing the same title keeps it
  liked, never unlikes (safe for a repeating timer).
- PC live update: **reuse the existing per-playlist likes SSE** (`like-update`).
- Auth: **same login** — the watcher carries the user's JWT.
- Config delivery (v1): **manual** — token, playlistId, and capture rectangle set
  in the script's config block. No frontend work.

## Flow

```
Android emulator window (music game) on Windows
  → watcher.py loop (every ~N seconds):
       grab capture rectangle (mss)
       OCR region (PaddleOCR, Chinese)
       if text changed since last tick:
           POST /api/remote/like { playlistId, text }   header: Authorization: Bearer <token>
                ↓ backend
        matchAndLike: normalize text → best title match in that playlist
                    → if not already liked: create like + broadcast 'like-update'
                ↓
        PC playlist tab (already SSE-subscribed) fills the heart live
```

## Backend (build)

### Route: `POST /api/remote/like`
- Auth: standard JWT middleware (same as all routes).
- Body: `{ playlistId: uuid, text: string (1..200) }` — Zod validated.
- Response: `{ matched, clipId?, title?, liked, alreadyLiked }`.
- 200 on success (a non-match is `matched:false`, not an error).

### Service: `remoteService.matchAndLike(userId, playlistId, text)`
1. Permission: reuse `likeService.canToggleLike(userId, playlistId)`; else `ForbiddenError`.
2. Load the playlist's clips with song `{ title, artist, titlePinyin,
   titlePinyinConcat, titlePinyinInitials }` (same include shape as
   `getPlaylistById`).
3. **Match** — pure, testable `matchClipByText(text, clips)`:
   - Normalize: trim, collapse whitespace, strip surrounding punctuation;
     case-insensitive.
   - Tiered, first hit wins: (1) exact title; (2) substring either direction;
     (3) pinyin fallback vs `titlePinyinConcat`/`titlePinyinInitials`.
   - Multiple in a tier → shortest-title (closest) wins; deterministic. None → `null`.
4. **Like-only (idempotent)**: if matched, check `prisma.like` for
   `(playlistId, clipId)`.
   - present → `alreadyLiked:true, liked:true`; no toggle, no re-broadcast.
   - absent → create like + `broadcast(playlistId, 'like-update', { clipId,
     liked:true })` (same broadcast `toggleLike` uses; PC updates with no new
     realtime code).
5. Return the structured result.

### Why not reuse `toggleLike`
`toggleLike` flips state; a repeating loop re-seeing the same title would unlike
on the next tick. The new like-only path is idempotent. It reuses
`canToggleLike` and the same `broadcast(...)`, so the SSE contract is unchanged
and the PC's `usePlaylistLikes` subscription just works.

### Optional: match log
In-memory ring buffer (last ~20) of `{ at, text, matched, title }`, exposed via
`GET /api/remote/recent` (auth'd), to diagnose mislikes given "always like best
match". Optional in v1.

## Windows watcher script (build + document)

`tools/ocr-watcher/watcher.py` (Python 3, run from terminal):
- **Deps**: `mss` (screen grab), `paddleocr` + `paddlepaddle` (OCR), `requests`.
- **Config block** (top of file): `API_BASE`, `TOKEN`, `PLAYLIST_ID`,
  `CAPTURE_RECT = {top,left,width,height}`, `INTERVAL_SEC`, `MIN_CONFIDENCE`.
- **Loop**: every `INTERVAL_SEC`, grab `CAPTURE_RECT`, run PaddleOCR, join the
  recognized lines into a candidate title (highest-confidence line, or the
  region's text), drop results below `MIN_CONFIDENCE`.
- **Dedup**: remember last sent text; only POST when it changes (pairs with the
  idempotent endpoint to avoid spam).
- **POST** to `/api/remote/like` with the JWT; print each result
  (`matched`/`title`/`alreadyLiked`) to the console for feedback.
- **Setup notes**: how to find the emulator window's region (coordinates), how to
  get the token (from browser localStorage `music_app_token`) and playlistId
  (from the playlist URL), how to install deps, how to swap to Tesseract.
- `requirements.txt` pinned.

### Alternate clients (documented, not built)
The endpoint is client-agnostic; brief notes for **iOS Shortcut** (Back-Tap →
Extract Text → POST) and **Android Tasker** as one-tap alternates. Not part of v1
scope to build/test.

## Testing

- **`matchClipByText`** unit tests (pure, `backend/tests/`): exact, substring
  (both directions), pinyin fallback, no-match, tie-break determinism,
  punctuation/whitespace normalization.
- **Endpoint** live curl: matched→`liked:true`; repeat→`alreadyLiked:true`, no
  re-broadcast; non-match→`matched:false`; no-access playlist→403; bad body→400.
- **SSE end-to-end (manual):** open PC playlist, POST a matching title, heart
  fills live.
- **Watcher**: smoke-run against a static image / a region with known text →
  confirms OCR reads it and the POST path works. (OCR accuracy itself is
  environmental, not unit-tested.)

## Security / caveats

- JWT lives in the watcher config — a long-lived personal secret on your own PC.
  Acceptable for personal use; scoped "remote key" is future hardening.
- "Always like best match" + OCR → occasional mislikes on bad reads; the optional
  match log makes them visible. Unliking a mistake is a normal tap on the PC.
- PaddleOCR first-run downloads a model (hundreds of MB) and is slower to start;
  steady-state per-frame OCR on a small region is fast.
- Endpoint is idempotent and cheap; a basic per-user rate limit is a future nicety.

## Out of scope (v1)

- In-browser/web camera OCR.
- Native overlay app; iOS Simulator (Mac-only, can't host App Store games).
- Building/testing the iOS Shortcut or Tasker clients (documented only).
- PC "remote capture" helper panel (token/playlistId copy UI) and a region-picker GUI.
- Search-from-capture (only liking is in scope).
- Scoped remote API keys / token rotation.
