#!/bin/bash
set -e

echo "[api]    Starting API server..."
node --enable-source-maps ./dist/index.mjs &
API_PID=$!

echo "[worker] Starting video worker..."
node --enable-source-maps ./dist/worker.mjs &
WORKER_PID=$!

echo "[boot]   API PID=$API_PID  Worker PID=$WORKER_PID"

# If either process dies, kill the other and exit non-zero
wait -n
EXIT_CODE=$?
echo "[boot]   A process exited (code=$EXIT_CODE) — shutting down"
kill "$API_PID" "$WORKER_PID" 2>/dev/null || true
exit "$EXIT_CODE"
