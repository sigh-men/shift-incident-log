#!/bin/bash
# Backup of the Shift Log SQLite DB + attachments.
# Scheduled via Synology Task Scheduler (root, every 4 hours) with no argument.
# Keeps the newest 120 copies of each = ~20 days at 6 runs/day.
#
# Optional first argument = a LABEL for a pre-change backup. When given, a copy
# is also kept in pre-change/ and is NEVER auto-pruned — used before deploying
# new features so there's always a durable rollback point.
#   e.g.  backup.sh pre-notifications
#
# The DB is copied with SQLite's .backup (via better-sqlite3 in the running
# container) so it's a consistent snapshot even if the app is mid-write.

set -euo pipefail

APP_DIR="/volume1/docker/shiftlog"
DATA_DIR="$APP_DIR/data"
DEST_DIR="/volume1/docker/shiftlog-backups"
DOCKER="/usr/local/bin/docker"
STAMP="$(date +%Y%m%d-%H%M%S)"
LABEL="$(echo "${1:-}" | tr -c 'A-Za-z0-9._-' '_' | sed 's/_*$//')"   # sanitized optional pre-change label
KEEP=120

mkdir -p "$DEST_DIR"

# 1. Consistent SQLite snapshot into the data dir, then move it out.
$DOCKER exec shiftlog node -e \
  "const db=require('better-sqlite3')('/data/shiftlog.db'); db.backup('/data/_snapshot.db').then(()=>{db.close();process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"
mv "$DATA_DIR/_snapshot.db" "$DEST_DIR/shiftlog-$STAMP.db"

# 2. Attachments tarball.
if [ -d "$DATA_DIR/attachments" ]; then
  tar -czf "$DEST_DIR/attachments-$STAMP.tar.gz" -C "$DATA_DIR" attachments
fi

# 3. Durable pre-change copy (only when a label was passed). Kept in a
#    subfolder that pruning never touches, so a rollback point always survives.
if [ -n "$LABEL" ]; then
  PC="$DEST_DIR/pre-change"
  mkdir -p "$PC"
  cp "$DEST_DIR/shiftlog-$STAMP.db" "$PC/shiftlog-$STAMP-$LABEL.db"
  [ -f "$DEST_DIR/attachments-$STAMP.tar.gz" ] && \
    cp "$DEST_DIR/attachments-$STAMP.tar.gz" "$PC/attachments-$STAMP-$LABEL.tar.gz"
  echo "[$(date)] PRE-CHANGE backup kept: pre-change/shiftlog-$STAMP-$LABEL.db (not auto-pruned)"
fi

# 4. Prune old routine copies (keep the newest $KEEP of each). The glob is
#    non-recursive, so pre-change/ is never affected.
ls -1t "$DEST_DIR"/shiftlog-*.db 2>/dev/null        | tail -n +$((KEEP+1)) | xargs -r rm -f
ls -1t "$DEST_DIR"/attachments-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f

echo "[$(date)] backup complete: shiftlog-$STAMP.db"
