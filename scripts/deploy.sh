#!/usr/bin/env bash
# Deploy Sideways to localhost VM.
#
# Usage:
#   ./scripts/deploy.sh          # full deploy (sync + build + restart all)
#   ./scripts/deploy.sh --quick  # sync + restart (skip build, use existing)
#   ./scripts/deploy.sh --infra  # only sync and rebuild Docker infra

set -euo pipefail

cd "$(dirname "$0")/.."

VM="$DEPLOY_HOST"
APP_DIR="/opt/sideways"
INFRA_DIR="/home/admin"

QUICK=false
INFRA_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=true ;;
    --infra) INFRA_ONLY=true ;;
  esac
done

# ── Sync infra (Docker compose, configs) ─────────────────────────────

sync_infra() {
  echo "==> Syncing infra..."
  rsync -az --delete \
    infra/compose.yml \
    infra/init-db.sql \
    infra/.env.example \
    $VM:$INFRA_DIR/

  rsync -az --delete infra/hydra/ $VM:$INFRA_DIR/hydra/
  rsync -az --delete infra/kratos/ $VM:$INFRA_DIR/kratos/
  rsync -az --delete infra/scripts/ $VM:$INFRA_DIR/scripts/
  rsync -az --delete infra/weasyprint/ $VM:$INFRA_DIR/weasyprint/

  # Create infra .env if missing
  ssh $VM "test -f $INFRA_DIR/.env || cp $INFRA_DIR/.env.example $INFRA_DIR/.env"
}

rebuild_infra() {
  echo "==> Rebuilding Docker services..."
  ssh $VM "cd $INFRA_DIR && docker compose up -d --build"
}

if $INFRA_ONLY; then
  sync_infra
  rebuild_infra
  echo "==> Infra deploy done."
  exit 0
fi

# ── Sync application code ────────────────────────────────────────────

echo "==> Syncing application code..."
rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude test-results \
  --exclude e2e \
  --exclude "*.test.ts" \
  --exclude ".env" \
  --include ".env.example" \
  ./ $VM:$APP_DIR/

# ── Sync infra too ───────────────────────────────────────────────────
sync_infra

# ── Build on VM ──────────────────────────────────────────────────────

# ── Create app .env if missing ───────────────────────────────────────

ssh $VM "test -f $APP_DIR/.env || cp $APP_DIR/.env.example $APP_DIR/.env"

# ── Build on VM ──────────────────────────────────────────────────────

if ! $QUICK; then
  echo "==> Installing dependencies..."
  ssh $VM "cd $APP_DIR && pnpm install --frozen-lockfile"

  echo "==> Building web frontend..."
  ssh $VM "set -a && source $APP_DIR/.env && set +a && cd $APP_DIR && pnpm --filter @sideways/web build"
fi

# ── Deploy nginx config ──────────────────────────────────────────────

echo "==> Updating nginx..."
ssh $VM "sudo cp $APP_DIR/infra/nginx.conf /etc/nginx/sites-available/sideways && \
  sudo ln -sf /etc/nginx/sites-available/sideways /etc/nginx/sites-enabled/sideways && \
  sudo rm -f /etc/nginx/sites-enabled/default && \
  sudo nginx -t && sudo systemctl reload nginx"

# ── Restart Docker services (picks up .env changes) ──────────────────

echo "==> Restarting Docker services..."
ssh $VM "cd $INFRA_DIR && docker compose up -d"

# ── Restart app services ─────────────────────────────────────────────

echo "==> Restarting app services..."
ssh $VM "sudo systemctl restart sideways-api sideways-web"

# ── Verify ───────────────────────────────────────────────────────────

echo "==> Waiting for services..."
sleep 3

API_STATUS=$(ssh $VM "curl -sf http://localhost:4100/health 2>/dev/null" || echo "FAIL")
WEB_STATUS=$(ssh $VM "curl -sf -o /dev/null -w '%{http_code}' http://localhost:4000 2>/dev/null" || echo "FAIL")

echo ""
echo "  API:  $API_STATUS"
echo "  Web:  $WEB_STATUS"
echo ""

if [[ "$API_STATUS" == *"ok"* ]]; then
  echo "==> Deploy complete. Site: http://localhost"
else
  echo "==> Deploy finished but API health check failed."
  echo "    Check logs: ssh $VM 'journalctl -u sideways-api -n 50'"
fi
