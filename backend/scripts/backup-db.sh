#!/bin/bash
# Pull the latest DB backup from the VM to local backups/ folder.
# Usage: cd backend && npm run backup
#
# Downloads today's backup. If today's hasn't been created yet (before 3am UTC+8),
# downloads the most recent one available.

BACKUP_DIR="$(cd "$(dirname "$0")/../../backups" && pwd)"
ZONE="asia-east2-a"
VM="music-app"
REMOTE_DIR="/home/chaol/backups"

# Try today's file first
TODAY=$(date +%Y%m%d)
REMOTE_FILE="$REMOTE_DIR/music_app_${TODAY}.sql.gz"

echo "Checking for today's backup (${TODAY})..."
if gcloud compute ssh $VM --zone=$ZONE --command="test -f $REMOTE_FILE" 2>/dev/null; then
  echo "Downloading music_app_${TODAY}.sql.gz..."
  gcloud compute scp "$VM:$REMOTE_FILE" "$BACKUP_DIR/" --zone=$ZONE
else
  echo "Today's backup not found. Fetching the latest..."
  LATEST=$(gcloud compute ssh $VM --zone=$ZONE --command="ls -t $REMOTE_DIR/music_app_*.sql.gz | head -1" 2>/dev/null)
  if [ -z "$LATEST" ]; then
    echo "No backups found on VM."
    exit 1
  fi
  FILENAME=$(basename "$LATEST")
  echo "Downloading $FILENAME..."
  gcloud compute scp "$VM:$LATEST" "$BACKUP_DIR/" --zone=$ZONE
fi

# Keep only last 7 local backups
cd "$BACKUP_DIR" && ls -t music_app_*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f

echo "Done. Local backups:"
ls -lh "$BACKUP_DIR"/music_app_*.sql.gz 2>/dev/null
