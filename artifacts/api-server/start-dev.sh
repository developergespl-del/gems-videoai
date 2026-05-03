#!/bin/bash
set -e

# Start Redis if not already running
if redis-cli ping > /dev/null 2>&1; then
  echo "[redis] Already running"
else
  echo "[redis] Starting Redis server..."
  redis-server --daemonize yes \
    --logfile /tmp/redis-gems.log \
    --port 6379 \
    --save ""
  sleep 0.5
  echo "[redis] Started"
fi

# Build TypeScript (API server + worker)
export NODE_ENV=development
echo "[build] Compiling..."
node build.mjs

# Start the worker in the background
echo "[worker] Starting video worker..."
node --enable-source-maps ./dist/worker.mjs &
WORKER_PID=$!
echo "[worker] PID: $WORKER_PID"

# Start the API server in the foreground (workflow logs come from here)
echo "[api] Starting API server..."
exec node --enable-source-maps ./dist/index.mjs
