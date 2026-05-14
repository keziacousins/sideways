#!/usr/bin/env bash
# One-time setup for the Sideways deploy host.
# Run this locally: DEPLOY_HOST=user@host ./scripts/setup-vm.sh
#
# Installs Node.js, pnpm, nginx, and sets up systemd services.

set -euo pipefail

VM="${DEPLOY_HOST:?Set DEPLOY_HOST=user@host (target SSH destination)}"
APP_DIR="${APP_DIR:-/opt/sideways}"
SERVICE_USER="${SERVICE_USER:-admin}"

echo "==> Installing Node.js 24, pnpm, and nginx on $VM..."

ssh "$VM" "APP_DIR='$APP_DIR' SERVICE_USER='$SERVICE_USER' sudo --preserve-env=APP_DIR,SERVICE_USER bash -s" <<'REMOTE'
set -euo pipefail

# Node.js 24 via NodeSource. Reinstall if the major version is below 24 —
# package.json's "engines" field requires it.
DESIRED_NODE_MAJOR=24
CURRENT_NODE_MAJOR=0
if command -v node &>/dev/null; then
  CURRENT_NODE_MAJOR=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
fi

if [ "$CURRENT_NODE_MAJOR" -lt "$DESIRED_NODE_MAJOR" ]; then
  echo "Installing Node.js $DESIRED_NODE_MAJOR (was: ${CURRENT_NODE_MAJOR:-none})..."
  curl -fsSL "https://deb.nodesource.com/setup_${DESIRED_NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  echo "Node $(node --version) installed"
else
  echo "Node $(node --version) is already at or above $DESIRED_NODE_MAJOR"
fi

# pnpm — reinstall after a Node bump so the shim points at the new node.
if ! command -v pnpm &>/dev/null || [ "$CURRENT_NODE_MAJOR" -lt "$DESIRED_NODE_MAJOR" ]; then
  npm install -g pnpm
  echo "pnpm $(pnpm --version) installed"
else
  echo "pnpm $(pnpm --version) already installed"
fi

# tsx (for running TypeScript directly in production). Same logic: reinstall
# after a Node bump.
if ! command -v tsx &>/dev/null || [ "$CURRENT_NODE_MAJOR" -lt "$DESIRED_NODE_MAJOR" ]; then
  npm install -g tsx
  echo "tsx installed"
fi

# nginx
if ! command -v nginx &>/dev/null; then
  apt-get install -y nginx
  systemctl enable nginx
  echo "nginx installed"
else
  echo "nginx already installed"
fi

# App directory
mkdir -p "$APP_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# Systemd service: sideways-api
cat > /etc/systemd/system/sideways-api.service <<EOF
[Unit]
Description=Sideways API Server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/tsx packages/server/src/index.ts
Restart=on-failure
RestartSec=3
EnvironmentFile=$APP_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

# Systemd service: sideways-web
cat > /etc/systemd/system/sideways-web.service <<EOF
[Unit]
Description=Sideways Web Frontend
After=network.target sideways-api.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR/packages/web
ExecStart=/usr/bin/node dist/server/entry.mjs
Environment=HOST=0.0.0.0
Environment=PORT=4000
Restart=on-failure
RestartSec=3
EnvironmentFile=$APP_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sideways-api sideways-web

echo "==> Deploy host setup complete."
REMOTE

echo "==> Done. Now run: DEPLOY_HOST=$VM ./scripts/deploy.sh"
