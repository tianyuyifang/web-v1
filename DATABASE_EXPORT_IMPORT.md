# Database Export & Import Guide

Export your local PostgreSQL `music_app` database and restore it on another machine (cloud VM, Codespaces, etc.).

## Prerequisites

- PostgreSQL installed on both source and target machines
- `pg_dump` and `pg_restore` available in PATH
- Database connection details for both environments

---

## 1. Export (Source Machine)

### Option A: Custom format (recommended — compressed, flexible)

```bash
pg_dump -U postgres -d music_app -F c -f music_app_backup.dump
```

### Option B: Plain SQL (human-readable)

```bash
pg_dump -U postgres -d music_app -f music_app_backup.sql
```

When prompted, enter your PostgreSQL password.

### What's included

The dump contains everything:
- Schema (all 9 tables: users, songs, song_artists, clips, playlists, playlist_clips, playlist_shares, playlist_copy_permissions, likes)
- All row data (songs, user-created clips, playlists, likes, etc.)
- Indexes, constraints, sequences

---

## 2. Transfer the dump file

Copy the dump file to the target machine. Options:
- `scp music_app_backup.dump user@remote:/path/` (SSH)
- Upload to cloud storage (S3, Google Drive, etc.) and download on target
- Commit to repo (only if no sensitive data) or use Git LFS

---

## 3. Import (Target Machine)

### Step 1: Create the database

```bash
createdb -U postgres music_app
```

### Step 2: Restore

**From custom format (.dump):**

```bash
pg_restore -U postgres -d music_app --no-owner --no-privileges music_app_backup.dump
```

**From plain SQL (.sql):**

```bash
psql -U postgres -d music_app -f music_app_backup.sql
```

- `--no-owner` skips original ownership (uses the restoring user instead)
- `--no-privileges` skips original GRANT/REVOKE statements

### Step 3: Sync Prisma client

```bash
cd backend && npx prisma generate
```

No need to run `prisma migrate deploy` or `npm run import` — the dump already contains the full schema and all data.

---

## 4. Update environment config

Edit `backend/.env` on the target machine:

```env
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/music_app
MP3_BASE_PATH=/path/to/music/allSongs
CLIPS_BASE_PATH=/path/to/music/allClips
```

---

## 5. Don't forget the MP3/LRC files

The database stores song metadata but the actual audio files live in the `music/` folder. You must also copy:

| Folder | Purpose |
|--------|---------|
| `music/allSongs/` | MP3 + LRC source files |
| `music/allClips/` | Generated clip audio files |

Update `MP3_BASE_PATH` and `CLIPS_BASE_PATH` in `.env` to match the new file locations.

---

## Quick Reference

| Step | Command |
|------|---------|
| Export | `pg_dump -U postgres -d music_app -F c -f music_app_backup.dump` |
| Create DB | `createdb -U postgres music_app` |
| Import | `pg_restore -U postgres -d music_app --no-owner --no-privileges music_app_backup.dump` |
| Sync Prisma | `cd backend && npx prisma generate` |
