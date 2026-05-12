#!/usr/bin/env bash
# Log health check for Sideways.
# Scans service logs and system state on the deploy host.
#
# Usage:
#   DEPLOY_HOST=user@host ./scripts/log-health.sh        # default: last 1 hour
#   DEPLOY_HOST=user@host ./scripts/log-health.sh 24h    # last 24 hours
#   DEPLOY_HOST=user@host ./scripts/log-health.sh 7d     # last 7 days

set -uo pipefail

VM="${DEPLOY_HOST:?Set DEPLOY_HOST=user@host (target SSH destination)}"
SINCE="${1:-1h}"

echo "═══════════════════════════════════════════════"
echo "  Sideways Log Health (last ${SINCE})"
echo "═══════════════════════════════════════════════"
echo

# ── Service status ───────────────────────────────
echo "SERVICE STATUS"
ssh "$VM" "sudo systemctl is-active sideways-api sideways-web 2>/dev/null | paste - - -d' '" | \
  awk '{ printf "  API: %s  Web: %s\n", $1, $2 }'
echo

ssh "$VM" "docker ps --format 'table {{.Names}}\t{{.Status}}' --filter 'name=admin-' 2>/dev/null" | \
  sed 's/^/  /'
echo

# ── Disk & memory ────────────────────────────────
echo "SYSTEM"
ssh "$VM" "df -h / | tail -1" | awk '{ printf "  Disk: %s used of %s (%s)\n", $3, $2, $5 }'
ssh "$VM" "free -h | grep Mem" | awk '{ printf "  Memory: %s used of %s\n", $3, $2 }'
echo

# ── Helpers ───────────────────────────────────────
jlog() { ssh "$VM" "sudo journalctl -u $1 --since '-${SINCE}' --no-pager 2>/dev/null | grep -ci '$2' || echo 0" 2>/dev/null | tail -1; }
dklog() { ssh "$VM" "docker logs --since '${SINCE}' $1 2>&1 | grep -c '$2' || echo 0" 2>/dev/null | tail -1; }

# ── API errors ───────────────────────────────────
echo "API SERVER"
api_errors=$(jlog sideways-api 'error\|ERR\|FATAL')
api_requests=$(jlog sideways-api 'INFO: Request')
api_4xx=$(ssh "$VM" "sudo journalctl -u sideways-api --since '-${SINCE}' --no-pager 2>/dev/null | grep -oP 'status: \K4\d\d' | sort | uniq -c | sort -rn" || echo "")
api_5xx=$(ssh "$VM" "sudo journalctl -u sideways-api --since '-${SINCE}' --no-pager 2>/dev/null | grep -oP 'status: \K5\d\d' | sort | uniq -c | sort -rn" || echo "")
echo "  Requests:       $api_requests"
echo "  Error lines:    $api_errors"
if [ -n "$api_4xx" ]; then
  echo "  4xx responses:"
  echo "$api_4xx" | sed 's/^/    /'
fi
if [ -n "$api_5xx" ]; then
  echo "  5xx responses:"
  echo "$api_5xx" | sed 's/^/    /'
fi
echo

# ── Web server errors ────────────────────────────
echo "WEB SERVER"
web_errors=$(jlog sideways-web 'error\|ERR\|FATAL')
web_refreshes=$(jlog sideways-web 'Token refresh failed')
web_callbacks=$(jlog sideways-web 'callback.*session set')
echo "  Error lines:        $web_errors"
echo "  Token refresh fails: $web_refreshes"
echo "  Successful logins:  $web_callbacks"
echo

if [ "$web_errors" -gt 0 ]; then
  echo "  Recent web errors:"
  ssh "$VM" "sudo journalctl -u sideways-web --since '-${SINCE}' --no-pager 2>/dev/null | grep -i 'error\|ERR' | tail -5" | sed 's/^/    /'
  echo
fi

# ── Kratos (auth) ────────────────────────────────
echo "KRATOS (Identity)"
kratos_reg_ok=$(dklog admin-kratos-1 "Identity created successfully")
kratos_reg_fail=$(dklog admin-kratos-1 "self-service flow error")
kratos_login_fail=$(dklog admin-kratos-1 "self-service login error")
echo "  Registrations OK:   $kratos_reg_ok"
echo "  Registration fails: $kratos_reg_fail"
echo "  Login fails:        $kratos_login_fail"
echo

if [ "$kratos_reg_fail" -gt 0 ] 2>/dev/null || [ "$kratos_login_fail" -gt 0 ] 2>/dev/null; then
  echo "  Recent auth errors:"
  ssh "$VM" "docker logs --since '${SINCE}' admin-kratos-1 2>&1 | grep -i 'error' | grep -oP 'msg=\K[^ ]+.*' | tail -5" | sed 's/^/    /'
  echo
fi

# ── Hydra (OAuth) ────────────────────────────────
echo "HYDRA (OAuth)"
hydra_errors=$(dklog admin-hydra-1 "access denied")
hydra_csrf=$(dklog admin-hydra-1 "CSRF")
hydra_token_fail=$(dklog admin-hydra-1 "invalid_grant")
echo "  Errors:             $hydra_errors"
echo "  CSRF failures:      $hydra_csrf"
echo "  Token grant fails:  $hydra_token_fail"
echo

if [ "$hydra_csrf" -gt 0 ] 2>/dev/null; then
  echo "  ⚠  CSRF failures detected — check OAuth cookie flow"
  echo
fi

# ── Nginx ────────────────────────────────────────
echo "NGINX"
nginx_errors=$(ssh "$VM" "sudo tail -200 /var/log/nginx/error.log 2>/dev/null | wc -l || echo 0" | tail -1)
nginx_scanners=$(ssh "$VM" "sudo tail -500 /var/log/nginx/access.log 2>/dev/null | grep -cE ' 444 | 400 ' || echo 0" | tail -1)
echo "  Error log lines:    $nginx_errors"
echo "  Blocked scanners:   $nginx_scanners"
echo

echo "═══════════════════════════════════════════════"
echo "  Health check: $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════"
