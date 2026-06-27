# Remote OCR Auto-Like (Phone → PC) — Design

**Date:** 2026-06-27
**Status:** Approved (design), pending implementation plan
**Area:** new `POST /api/remote/like` endpoint + iOS Shortcut setup docs

## Problem

User browses the website on a PC. While doing so, they want to use their iPhone
to capture song titles shown on the phone screen (in another app — a music game,
karaoke, etc.) and have those titles automatically "like" the matching clip in a
chosen playlist on the PC, updating the PC view in real time.

## Key constraint (why this shape)

A mobile **web page cannot read pixels from another app or a fixed screen
region** — the browser sandbox forbids it. Reading another app's on-screen
content requires OS-level capture. Therefore the **capture + OCR happens in iOS
Shortcuts** (which can extract text from the screen/a screenshot region on a
trigger), and the **only thing we build is a small API endpoint** plus the live
PC update (which already exists via SSE).

## Decisions

- Capture host: **iOS Shortcuts** (user-configured; OCR a region, POST text).
- Action: **auto-like the best title match** within **one chosen playlist**.
- Like semantics: **like-only / idempotent** — re-reading the same title keeps it
  liked, never unlikes (safe for a repeating timer).
- PC live update: **reuse the existing per-playlist likes SSE** (`like-update`
  event). No new realtime code.
- Pairing: **same login on both** — the Shortcut carries the user's JWT.
- Token + playlistId delivery for v1: **manual paste** into the Shortcut (no
  frontend work). A PC helper panel is a possible later enhancement.

## Flow

```
iPhone Shortcut (Back-Tap or timed automation)
  → Extract Text from screen region
  → POST /api/remote/like  { playlistId, text }   header: Authorization: Bearer <token>
        ↓ backend
  matchAndLike: normalize text → best title match among that playlist's clips
              → if not already liked: create like + broadcast 'like-update'
        ↓
  PC playlist tab (already SSE-subscribed) fills the heart in real time
```

## Backend (the only build)

### Route: `POST /api/remote/like`
- Auth: standard JWT middleware (same as all routes).
- Body: `{ playlistId: uuid, text: string (1..200) }` — Zod validated.
- Response: `{ matched: boolean, clipId?: string, title?: string, liked: boolean, alreadyLiked: boolean }`.
- 200 on success (including `matched:false` — a non-match is not an error).

### Service: `remoteService.matchAndLike(userId, playlistId, text)`
1. Permission: reuse `likeService.canToggleLike(userId, playlistId)` — caller must
   have access to the playlist; else `ForbiddenError`.
2. Load the playlist's clips with song `{ title, artist, titlePinyin,
   titlePinyinConcat, titlePinyinInitials }` — same include shape
   `getPlaylistById` uses.
3. **Match** (pure, testable function `matchClipByText(text, clips)`):
   - Normalize: trim, collapse whitespace, strip surrounding punctuation; keep
     case-insensitive compare.
   - Tiered match, first hit wins:
     1. exact title (normalized, case-insensitive)
     2. title contains the text, or text contains the title (substring)
     3. pinyin fallback: normalized text vs `titlePinyinConcat` /
        `titlePinyinInitials` (reuse existing pinyin fields)
   - On multiple candidates in a tier, pick the shortest-title (closest) match;
     deterministic. On none, return `null`.
4. **Like-only**: if a clip matched, check `prisma.like` for an existing
   `(playlistId, clipId)` row.
   - If present → `alreadyLiked:true, liked:true`, do **not** toggle, do **not**
     re-broadcast.
   - If absent → create the like and `broadcast(playlistId, 'like-update',
     { clipId, liked:true })` (same broadcast `toggleLike` uses, so the PC
     updates with no new realtime code).
5. Return the structured result.

### Why not reuse `toggleLike` directly
`toggleLike` flips state; a repeating timer re-reading the same on-screen title
would unlike on the next tick. The new like-only path is idempotent. It still
reuses `canToggleLike` and the same `broadcast(...)` call, so the SSE contract is
unchanged and the PC's existing `usePlaylistLikes` subscription just works.

### Optional: lightweight match log
Keep an in-memory ring buffer (last ~20) of `{ at, text, matched, title }` for
debugging mislikes, exposed via a tiny `GET /api/remote/recent` (auth'd). Helps
diagnose OCR errors given "always like best match". Optional in v1.

## Phone (user-configured; we document)

iOS Shortcut, documented step-by-step in the plan:
1. Trigger: **Back-Tap** (Settings → Accessibility) or a timed Personal Automation.
2. **Take Screenshot** (or use a cropped region) → **Extract Text from Image**.
   (Optionally crop to the title region first.)
3. **Text** → build JSON `{ "playlistId": "<id>", "text": <extracted> }`.
4. **Get Contents of URL**: POST to `https://<host>/api/remote/like`, header
   `Authorization: Bearer <token>`, `Content-Type: application/json`, request body
   the JSON.
5. (Optional) Show Notification with the response `matched`/`title` for feedback.

Token + playlistId are pasted into the Shortcut by hand for v1.

## Testing

- **`matchClipByText`** unit tests (pure): exact, substring (both directions),
  pinyin fallback, no-match, tie-break determinism, punctuation/whitespace
  normalization. Plain-Node test in `backend/tests/`.
- **Endpoint** manual verification (live curl): matched→like+`liked:true`;
  repeat→`alreadyLiked:true` no re-broadcast; non-match→`matched:false`;
  no-access playlist→403; bad body→400.
- **SSE end-to-end (manual):** open the PC playlist, POST a matching title, see
  the heart fill live.

## Security / caveats

- The JWT lives in the Shortcut — a long-lived personal secret on the phone.
  Acceptable for personal use; a scoped "remote key" is a future hardening step.
- "Always like best match" + OCR means occasional mislikes on bad reads; the
  optional match log mitigates by making them visible. Unliking a mistake is a
  normal tap on the PC.
- Endpoint is rate-limit-friendly: idempotent and cheap; consider a basic
  per-user rate limit if a timer runs hot (future).

## Out of scope (v1)

- In-app/in-browser OCR or camera capture.
- A native overlay app.
- PC "remote capture" helper panel (token/playlistId copy UI).
- Search-from-phone (only liking is in scope).
- Scoped remote API keys / token rotation.
