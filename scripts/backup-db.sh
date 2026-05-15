#!/usr/bin/env bash
# Back up the deploy host's Postgres database to local `backups/`.
#
# Required env vars:
#   DEPLOY_HOST   SSH target, e.g. admin@my-server.example.com
#
# Optional env vars:
#   INFRA_DIR     Remote infra (docker compose) directory (default: /home/admin)
#
# Usage:
#   DEPLOY_HOST=admin@my-server ./scripts/backup-db.sh
#
# Output:
#   backups/sideways-YYYYMMDD-HHMMSS.sql
#
# The dump uses `--no-owner --no-acl --clean --if-exists` so it can be
# restored cleanly onto an existing database. To restore:
#   psql -h ... -U ... -d ... < backups/sideways-...sql

set -euo pipefail

cd "$(dirname "$0")/.."

VM="${DEPLOY_HOST:?Set DEPLOY_HOST=user@host (target SSH destination)}"
INFRA_DIR="${INFRA_DIR:-/home/admin}"

mkdir -p backups
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="backups/sideways-${TIMESTAMP}.sql"

echo "==> Backing up $VM database to $BACKUP_FILE..."
ssh "$VM" "set -a && source $INFRA_DIR/.env && set +a && \
  docker compose -f $INFRA_DIR/compose.yml exec -T postgres \
  pg_dump -U \$POSTGRES_USER --no-owner --no-acl --clean --if-exists \${POSTGRES_DB:-sideways}" \
  > "$BACKUP_FILE"

if [ ! -s "$BACKUP_FILE" ]; then
  echo "==> Backup is empty. Aborting."
  rm -f "$BACKUP_FILE"
  exit 1
fi

echo "==> Backed up: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
