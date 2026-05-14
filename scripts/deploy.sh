#!/usr/bin/env bash
# Deploy Sideways to a remote host over SSH.
#
# Required env vars:
#   DEPLOY_HOST   SSH target, e.g. admin@my-server.example.com
#
# Optional env vars:
#   APP_DIR       Remote application directory (default: /opt/sideways)
#   INFRA_DIR     Remote infra (docker compose) directory (default: home dir of DEPLOY_HOST user)
#
# Usage:
#   DEPLOY_HOST=admin@my-server ./scripts/deploy.sh           # full deploy
#   DEPLOY_HOST=admin@my-server ./scripts/deploy.sh --quick   # skip build
#   DEPLOY_HOST=admin@my-server ./scripts/deploy.sh --infra   # rebuild Docker infra only

set -euo pipefail

cd "$(dirname "$0")/.."

VM="${DEPLOY_HOST:?Set DEPLOY_HOST=user@host (target SSH destination)}"
APP_DIR="${APP_DIR:-/opt/sideways}"
INFRA_DIR="${INFRA_DIR:-/home/admin}"

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
  --exclude ".sessions" \
  --include ".env.example" \
  ./ $VM:$APP_DIR/

# ── Sync infra too ───────────────────────────────────────────────────
sync_infra

# ── Create app .env if missing ───────────────────────────────────────

ssh $VM "test -f $APP_DIR/.env || cp $APP_DIR/.env.example $APP_DIR/.env"

# ── Validate .env files have every key from .env.example ─────────────
#
# Catches the case where a new required secret/var lands on main but the
# VM's .env wasn't updated — failing here is much friendlier than a
# cryptic interpolation error inside docker compose three steps later.

check_env_keys() {
  local label="$1" example_path="$2" actual_path="$3"
  local example_keys actual_keys missing
  example_keys=$(ssh $VM "grep -E '^[A-Z_][A-Z0-9_]*=' $example_path | cut -d= -f1 | sort -u")
  actual_keys=$(ssh $VM "grep -E '^[A-Z_][A-Z0-9_]*=' $actual_path  | cut -d= -f1 | sort -u")
  missing=$(comm -23 <(echo "$example_keys") <(echo "$actual_keys"))
  if [ -n "$missing" ]; then
    echo "==> Missing keys in $label ($actual_path):"
    echo "$missing" | sed 's/^/    - /'
    echo "    Run ./scripts/gen-secrets.sh for fresh secret values."
    exit 1
  fi
}

echo "==> Validating env files..."
check_env_keys "infra .env"  "$INFRA_DIR/.env.example" "$INFRA_DIR/.env"
check_env_keys "app .env"    "$APP_DIR/.env.example"   "$APP_DIR/.env"

# ── Build on VM ──────────────────────────────────────────────────────

if ! $QUICK; then
  echo "==> Installing dependencies..."
  ssh $VM "cd $APP_DIR && pnpm install --frozen-lockfile"

  echo "==> Building CLI + MCP bundles..."
  ssh $VM "cd $APP_DIR && pnpm --filter @sideways/cli build && pnpm --filter @sideways/mcp build && mkdir -p packages/web/public/downloads && cp packages/cli/dist/sideways.cjs packages/mcp/dist/sideways-mcp.cjs packages/web/public/downloads/"

  echo "==> Building web frontend..."
  ssh $VM "set -a && source $APP_DIR/.env && set +a && cd $APP_DIR && pnpm --filter @sideways/web build"
fi

# ── Run one-shot data migrations (before schema push) ────────────────

echo "==> Running data migrations..."
ssh $VM "set -a && source $APP_DIR/.env && set +a && cd $APP_DIR && npx tsx scripts/migrate-paths-sections.ts"

# ── Push database schema ─────────────────────────────────────────────

echo "==> Pushing database schema..."
ssh $VM "set -a && source $APP_DIR/.env && set +a && cd $APP_DIR/shared/db && npx drizzle-kit push"

# ── Deploy nginx config ──────────────────────────────────────────────

echo "==> Updating nginx..."
ssh $VM "sudo cp $APP_DIR/infra/nginx.conf /etc/nginx/sites-available/sideways && \
  sudo ln -sf /etc/nginx/sites-available/sideways /etc/nginx/sites-enabled/sideways && \
  sudo rm -f /etc/nginx/sites-enabled/default && \
  sudo nginx -t && sudo systemctl reload nginx"

# ── Restart Docker services (rebuilds local images so kratos/hydra
#    config changes baked via Dockerfile actually land) ───────────────

echo "==> Restarting Docker services..."
ssh $VM "cd $INFRA_DIR && docker compose up -d --build"

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
  echo "==> Deploy complete."
else
  echo "==> Deploy finished but API health check failed."
  echo "    Check logs: ssh $VM 'journalctl -u sideways-api -n 50'"
fi
