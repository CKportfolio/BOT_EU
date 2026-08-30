#!/bin/sh
set -eu

BOT_MARKET="${BOT_MARKET:-BTCUSDT}"
BOT_CATEGORY="${BOT_CATEGORY:-spot}"

# Keep UI symbol/category aligned with bot by default.
UI_SYMBOL="${UI_SYMBOL:-$BOT_MARKET}"
UI_CATEGORY="${UI_CATEGORY:-$BOT_CATEGORY}"

echo "[bot7] starting UI server..."
node scripts/js/momentum_regime_server.js --mode live --symbol "$UI_SYMBOL" --category "$UI_CATEGORY" &
UI_PID=$!

echo "[bot7] starting bot worker..."
node index.js &
BOT_PID=$!

cleanup() {
  echo "[bot7] shutting down..."
  kill "$BOT_PID" 2>/dev/null || true
  kill "$UI_PID" 2>/dev/null || true
  wait "$BOT_PID" 2>/dev/null || true
  wait "$UI_PID" 2>/dev/null || true
}

trap cleanup INT TERM

# If UI dies unexpectedly, stop bot.
(
  wait "$UI_PID" || true
  echo "[bot7] UI process exited, stopping bot..."
  kill "$BOT_PID" 2>/dev/null || true
) &

# Main wait: container lifetime follows bot worker.
wait "$BOT_PID"
EXIT_CODE=$?

kill "$UI_PID" 2>/dev/null || true
wait "$UI_PID" 2>/dev/null || true

exit "$EXIT_CODE"
