#!/usr/bin/env bash
#
# Nightly dump of the indexer's database.
#
# The projection is rebuildable from chain history, so this is not protecting
# irreplaceable data — it is protecting the ~33 hours of archive requests that
# rebuilding would cost. That trade makes a compressed dump obviously worth it.
#
# Writes a compressed custom-format dump, keeps the newest KEEP files, and
# refuses to delete anything if the new dump did not actually succeed.
#
#   ./backup.sh
#   BACKUP_DIR=/mnt/backups KEEP=14 ./backup.sh
set -euo pipefail

CONTAINER="${CONTAINER:-gata-indexer-db}"
DB="${POSTGRES_DB:-gata_indexer}"
USER_NAME="${POSTGRES_USER:-indexer}"
BACKUP_DIR="${BACKUP_DIR:-/srv/indexer/backups}"
KEEP="${KEEP:-7}"

stamp="$(date -u +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/gata_indexer-$stamp.dump"

mkdir -p "$BACKUP_DIR"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "container '$CONTAINER' is not running" >&2
  exit 1
fi

echo "dumping $DB -> $out"
# -Fc is compressed and restorable selectively with pg_restore. Written to a
# temp name first so a half-written file can never be mistaken for a backup.
docker exec "$CONTAINER" pg_dump -U "$USER_NAME" -d "$DB" -Fc > "$out.partial"
mv "$out.partial" "$out"

size=$(du -h "$out" | cut -f1)
echo "wrote $size"

# Prune only after a good dump exists, so a failing job never erodes history.
count=$(ls -1 "$BACKUP_DIR"/gata_indexer-*.dump 2>/dev/null | wc -l)
if [ "$count" -gt "$KEEP" ]; then
  ls -1t "$BACKUP_DIR"/gata_indexer-*.dump | tail -n +$((KEEP + 1)) | while read -r old; do
    echo "pruning $(basename "$old")"
    rm -f "$old"
  done
fi

echo "done — $(ls -1 "$BACKUP_DIR"/gata_indexer-*.dump | wc -l) backup(s) retained"
