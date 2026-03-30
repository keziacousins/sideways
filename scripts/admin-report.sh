#!/usr/bin/env bash
# Activity report for Sideways.
# Queries Postgres on localhost for signups, content, and usage stats.
#
# Usage:
#   ./scripts/admin-report.sh           # default: last 7 days
#   ./scripts/admin-report.sh 1         # last 1 day
#   ./scripts/admin-report.sh 30        # last 30 days

set -uo pipefail

VM="$DEPLOY_HOST"
DAYS="${1:-7}"
PSQL="docker exec admin-postgres-1 psql -U sideways -d sideways --no-align --tuples-only"

run() { ssh "$VM" "$PSQL -c \"$1\"" 2>/dev/null; }
run_table() { ssh "$VM" "docker exec admin-postgres-1 psql -U sideways -d sideways -c \"$1\"" 2>/dev/null; }

echo "═══════════════════════════════════════════════"
echo "  Sideways Activity Report (last ${DAYS} days)"
echo "═══════════════════════════════════════════════"
echo

# ── Users ────────────────────────────────────────
total_users=$(run "SELECT count(*) FROM users WHERE email NOT LIKE '%@sideways.dev' AND email NOT LIKE 'system@%'")
recent_signups=$(run "SELECT count(*) FROM users WHERE created_at > now() - interval '${DAYS} days' AND email NOT LIKE '%@sideways.dev' AND email NOT LIKE 'system@%'")
echo "USERS (excluding e2e/system accounts)"
echo "  Total:          $total_users"
echo "  New signups:    $recent_signups"
echo

if [ "$recent_signups" -gt 0 ] 2>/dev/null; then
  echo "  Recent signups:"
  run_table "SELECT name, email, created_at::date as signed_up FROM users WHERE created_at > now() - interval '${DAYS} days' AND email NOT LIKE '%@sideways.dev' AND email NOT LIKE 'system@%' ORDER BY created_at DESC LIMIT 20"
  echo
fi

# ── Spaces ───────────────────────────────────────
total_spaces=$(run "SELECT count(*) FROM spaces")
recent_spaces=$(run "SELECT count(*) FROM spaces WHERE created_at > now() - interval '${DAYS} days'")
echo "SPACES"
echo "  Total:          $total_spaces"
echo "  New (${DAYS}d):      $recent_spaces"
echo

run_table "SELECT s.slug, s.name, s.visibility, u.email as owner, (SELECT count(*) FROM documents d WHERE d.space_id = s.id) as docs FROM spaces s JOIN users u ON s.owner_id = u.id ORDER BY docs DESC"
echo

# ── Documents ────────────────────────────────────
total_docs=$(run "SELECT count(*) FROM documents")
recent_docs=$(run "SELECT count(*) FROM documents WHERE created_at > now() - interval '${DAYS} days'")
recent_edits=$(run "SELECT count(*) FROM document_versions WHERE created_at > now() - interval '${DAYS} days'")
echo "DOCUMENTS"
echo "  Total:          $total_docs"
echo "  New (${DAYS}d):      $recent_docs"
echo "  Edits (${DAYS}d):    $recent_edits"
echo

if [ "$recent_edits" -gt 0 ] 2>/dev/null; then
  echo "  Recent activity:"
  run_table "
    SELECT d.title, s.slug as space, dv.version,
           coalesce(dv.author_name, u.name, 'unknown') as author,
           dv.created_at::timestamp(0) as edited_at
    FROM document_versions dv
    JOIN documents d ON dv.document_id = d.id
    JOIN spaces s ON d.space_id = s.id
    LEFT JOIN users u ON dv.author_id = u.id
    WHERE dv.created_at > now() - interval '${DAYS} days'
    ORDER BY dv.created_at DESC
    LIMIT 20
  "
  echo
fi

# ── Comments ─────────────────────────────────────
total_comments=$(run "SELECT count(*) FROM comments")
recent_comments=$(run "SELECT count(*) FROM comments WHERE created_at > now() - interval '${DAYS} days'")
open_comments=$(run "SELECT count(*) FROM comments WHERE resolved_at IS NULL AND parent_id IS NULL")
echo "COMMENTS"
echo "  Total:          $total_comments"
echo "  New (${DAYS}d):      $recent_comments"
echo "  Open threads:   $open_comments"
echo

# ── Reads & Watches ──────────────────────────────
recent_reads=$(run "SELECT count(*) FROM document_reads WHERE read_at > now() - interval '${DAYS} days'")
total_watches=$(run "SELECT count(*) FROM document_watches")
echo "ENGAGEMENT"
echo "  Doc reads (${DAYS}d): $recent_reads"
echo "  Active watches: $total_watches"
echo

# ── API Keys ─────────────────────────────────────
total_keys=$(run "SELECT count(*) FROM api_keys")
echo "API KEYS"
echo "  Total:          $total_keys"
echo
run_table "SELECT ak.name, ak.actor_name, u.email as owner, ak.created_at::date FROM api_keys ak JOIN users u ON ak.user_id = u.id ORDER BY ak.created_at DESC"
echo

echo "═══════════════════════════════════════════════"
echo "  Report generated: $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════"
