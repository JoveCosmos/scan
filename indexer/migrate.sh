#!/usr/bin/env bash
#
# Apply the schema to the indexer's Postgres.
#
# Piped over stdin rather than bind-mounted into docker-entrypoint-initdb.d:
# snap-packaged Docker cannot bind-mount from /srv, and this box runs the snap
# for other workloads, so mounting the repo into the container is not an option.
#
# Safe to run repeatedly — every statement is CREATE ... IF NOT EXISTS.
#
#   ./migrate.sh                 # uses the container named below
#   CONTAINER=other ./migrate.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${CONTAINER:-gata-indexer-db}"
DB="${POSTGRES_DB:-gata_indexer}"
USER_NAME="${POSTGRES_USER:-indexer}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "container '$CONTAINER' is not running" >&2
  exit 1
fi

for file in "$here"/sql/*.sql; do
  echo "applying $(basename "$file")"
  # ON_ERROR_STOP so a broken migration fails loudly instead of half-applying.
  docker exec -i "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$USER_NAME" -d "$DB" < "$file"
done

echo "schema applied"
docker exec -i "$CONTAINER" psql -U "$USER_NAME" -d "$DB" -c '\dt'
