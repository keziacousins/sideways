#!/usr/bin/env bash
# One-time setup for the localhost VM.
# Run this locally: ./scripts/setup-vm.sh
#
# Installs Node.js, pnpm, nginx, and sets up systemd services.

set -euo pipefail

VM="$DEPLOY_HOST"
APP_DIR="/opt/sideways"

echo "==> Installing Node.js 22, pnpm, and nginx on localhost..."

ssh $VM "sudo bash -s" <<'REMOTE'
set -euo pipefail

# Node.js 22 via NodeSource
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  echo "Node $(node --version) installed"
else
  echo "Node $(node --version) already installed"
fi

# pnpm
if ! command -v pnpm &>/dev/null; then
  npm install -g pnpm
  echo "pnpm $(pnpm --version) installed"
else
  echo "pnpm $(pnpm --version) already installed"
fi

# tsx (for running TypeScript directly in production)
if ! command -v tsx &>/dev/null; then
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
mkdir -p /opt/sideways
chown admin:admin /opt/sideways

# Systemd service: sideways-api
cat > /etc/systemd/system/sideways-api.service <<'EOF'
[Unit]
Description=Sideways API Server
After=network.target

[Service]
Type=simple
User=admin
WorkingDirectory=/opt/sideways
ExecStart=/usr/bin/tsx packages/server/src/index.ts
Restart=on-failure
RestartSec=3
EnvironmentFile=/opt/sideways/.env

[Install]
WantedBy=multi-user.target
EOF

# Systemd service: sideways-web
cat > /etc/systemd/system/sideways-web.service <<'EOF'
[Unit]
Description=Sideways Web Frontend
After=network.target sideways-api.service

[Service]
Type=simple
User=admin
WorkingDirectory=/opt/sideways/packages/web
ExecStart=/usr/bin/node dist/server/entry.mjs
Environment=HOST=0.0.0.0
Environment=PORT=4000
Restart=on-failure
RestartSec=3
EnvironmentFile=/opt/sideways/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sideways-api sideways-web

echo "==> VM setup complete."
REMOTE

echo "==> Done. Now run ./scripts/deploy.sh to deploy."
