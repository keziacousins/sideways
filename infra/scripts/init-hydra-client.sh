#!/bin/sh
# Register OAuth2 clients with Hydra.
# Runs as a one-shot init container after Hydra is healthy.

set -e

HYDRA_ADMIN_URL="${HYDRA_ADMIN_URL:-http://hydra:4445}"
PUBLIC_URL="${PUBLIC_URL:-http://localhost:4000}"

register_client() {
  CLIENT_ID="$1"
  CLIENT_JSON="$2"

  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${HYDRA_ADMIN_URL}/admin/clients/${CLIENT_ID}")

  if [ "$STATUS" = "200" ]; then
    echo "Client '${CLIENT_ID}' exists, deleting and recreating..."
    curl -sf -X DELETE "${HYDRA_ADMIN_URL}/admin/clients/${CLIENT_ID}" > /dev/null
  fi

  echo "Creating client '${CLIENT_ID}'..."
  curl -sf -X POST \
    -H "Content-Type: application/json" \
    -d "${CLIENT_JSON}" \
    "${HYDRA_ADMIN_URL}/admin/clients" > /dev/null
  echo "  Done."
}

echo "Waiting for Hydra..."
until curl -sf "${HYDRA_ADMIN_URL}/health/ready" > /dev/null 2>&1; do
  sleep 2
done
echo "Hydra is ready."

# Web app client (public — no secret, same as CLI)
register_client "sideways-web" '{
  "client_id": "sideways-web",
  "client_name": "Sideways Web App",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "openid offline_access",
  "redirect_uris": ["'"${PUBLIC_URL}"'/auth/callback"],
  "post_logout_redirect_uris": ["'"${PUBLIC_URL}"'/", "'"${PUBLIC_URL}"'/auth/login"],
  "token_endpoint_auth_method": "none",
  "skip_consent": true
}'

# CLI client (public, PKCE)
register_client "sideways-cli" '{
  "client_id": "sideways-cli",
  "client_name": "Sideways CLI",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "openid offline_access",
  "redirect_uris": ["http://localhost:19876/callback"],
  "token_endpoint_auth_method": "none",
  "skip_consent": true
}'

echo "All clients registered."
