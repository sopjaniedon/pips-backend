#!/usr/bin/env bash
# Backup of the PIPS database and file storage.
#   scripts/backup.sh                 -> data/backups/db/pips-<UTC time>.dump + data/backups/storage/
#   BACKUP_DIR=/mnt/backup scripts/backup.sh
#   BACKUP_FILES=0 scripts/backup.sh   database only
# The dump and the storage copy contain personal data (applicants, messages): keep BACKUP_DIR on an encrypted disk.
# Passport fields are encrypted with PII_KEYS from .env, which is NOT copied here: back the keys up separately,
# or the passport fields in every backup are unreadable.
set -euo pipefail
cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PG="$(docker ps -qf label=com.docker.compose.project=pips -f label=com.docker.compose.service=postgres)"
[ -n "$PG" ] || { echo "The postgres container is not running (pnpm up)." >&2; exit 1; }
mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/storage"
umask 077

# 1. Database: one consistent snapshot, custom format (pg_restore can restore single tables if needed).
DUMP="$BACKUP_DIR/db/pips-$STAMP.dump"
docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' > "$DUMP.part"
mv "$DUMP.part" "$DUMP"
shasum -a 256 "$DUMP" > "$DUMP.sha256"

# 2. Files: content-addressed (a file never changes once written), so a plain rsync is incremental.
#    Nothing is deleted from the copy, so files removed later can still be restored.
if [ "${BACKUP_FILES:-1}" != 0 ]; then rsync -a --exclude 'tmp/' data/storage/ "$BACKUP_DIR/storage/"; fi

# 3. Keep dumps for KEEP_DAYS days.
find "$BACKUP_DIR/db" -name 'pips-*.dump*' -mtime +"$KEEP_DAYS" -delete

echo "Backup done: $DUMP ($(du -h "$DUMP" | cut -f1))$([ "${BACKUP_FILES:-1}" != 0 ] && echo ", files copied to $BACKUP_DIR/storage")"
echo "Reminder: PII_KEYS and SESSION_SECRET are not in this backup; keep a separate copy of .env's keys."
