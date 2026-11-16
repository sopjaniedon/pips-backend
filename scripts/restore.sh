#!/usr/bin/env bash
# Restores a database dump made by backup.sh.
#   scripts/restore.sh <dump> --into <new database name>        restore next to the live database (safe; for checks)
#   scripts/restore.sh <dump> --replace-live --yes [--files]    replace the live database (stop the API first)
#     --files   also copy data/backups/storage back into data/storage (only adds missing files)
set -euo pipefail
cd "$(dirname "$0")/.."
DUMP="${1:-}"; shift || true
INTO=""; REPLACE=0; YES=0; FILES=0
while [ $# -gt 0 ]; do case "$1" in
  --into) INTO="$2"; shift 2 ;; --replace-live) REPLACE=1; shift ;; --yes) YES=1; shift ;; --files) FILES=1; shift ;;
  *) echo "Unknown option $1" >&2; exit 2 ;; esac; done
[ -f "$DUMP" ] || { echo "Usage: scripts/restore.sh <dump> --into <name> | --replace-live --yes [--files]" >&2; exit 2; }
if [ -f "$DUMP.sha256" ]; then shasum -a 256 -c "$DUMP.sha256" >/dev/null || { echo "Checksum mismatch for $DUMP" >&2; exit 1; }; fi
PG="$(docker ps -qf label=com.docker.compose.project=pips -f label=com.docker.compose.service=postgres)"
[ -n "$PG" ] || { echo "The postgres container is not running (pnpm up)." >&2; exit 1; }
LIVE="$(docker exec "$PG" sh -c 'echo "$POSTGRES_DB"')"

if [ "$REPLACE" = 1 ]; then
  [ "$YES" = 1 ] || { echo "Replacing the live database '$LIVE' needs --yes." >&2; exit 2; }
  TARGET="$LIVE"
  docker exec "$PG" sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS \"$TARGET\" WITH (FORCE)' -c 'CREATE DATABASE \"$TARGET\"'"
else
  [ -n "$INTO" ] || { echo "Give --into <name> (a new database) or --replace-live --yes." >&2; exit 2; }
  [ "$INTO" != "$LIVE" ] || { echo "--into must not be the live database; use --replace-live." >&2; exit 2; }
  [[ "$INTO" =~ ^[a-z][a-z0-9_]{2,40}$ ]] || { echo "Database name: lower-case letters, digits, _" >&2; exit 2; }
  TARGET="$INTO"
  docker exec "$PG" sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE \"$TARGET\"'"
fi
docker exec -i "$PG" sh -c "pg_restore -U \"\$POSTGRES_USER\" -d \"$TARGET\" --no-owner --exit-on-error" < "$DUMP"
if [ "$FILES" = 1 ]; then rsync -a --ignore-existing "${BACKUP_DIR:-./data/backups}/storage/" data/storage/; fi
echo "Restored $DUMP into database '$TARGET'."
