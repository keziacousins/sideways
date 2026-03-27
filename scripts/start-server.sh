#!/usr/bin/env bash
# Start the Sideways API server and web frontend.
# Usage: ./scripts/start-server.sh [--api-only] [--web-only]

set -e
cd "$(dirname "$0")/.."

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $API_PID $WEB_PID 2>/dev/null
  wait $API_PID $WEB_PID 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

API_PID=""
WEB_PID=""

start_api() {
  echo "Starting API server (port 4100)..."
  pnpm --filter @sideways/server dev &
  API_PID=$!
}

start_web() {
  echo "Starting web frontend (port 4000)..."
  pnpm --filter @sideways/web dev &
  WEB_PID=$!
}

case "${1:-}" in
  --api-only)
    start_api
    ;;
  --web-only)
    start_web
    ;;
  *)
    start_api
    start_web
    ;;
esac

wait
