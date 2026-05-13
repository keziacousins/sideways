#!/usr/bin/env bash
# Print fresh values for the secrets in .env.example, ready to paste.
# Usage:
#   ./scripts/gen-secrets.sh

set -euo pipefail

# A long random string for general-purpose secrets (alphanumeric).
rand_str() {
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-48}"
}

echo "POSTGRES_PASSWORD=$(rand_str 32)"
echo "HYDRA_SYSTEM_SECRET=$(rand_str 48)"
echo "KRATOS_COOKIE_SECRET=$(rand_str 48)"
# Kratos cipher secret must be exactly 32 ASCII characters.
echo "KRATOS_CIPHER_SECRET=$(rand_str 32)"
echo "KRATOS_WEBHOOK_SECRET=$(rand_str 48)"
