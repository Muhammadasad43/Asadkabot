#!/bin/sh
# One container, two processes: Flask (public, $PORT) + Asad MD (background).
# On a redeploy/stop Render sends SIGTERM: we forward it to the bot first so it
# can copy everything waiting in memory to Postgres, then stop the web server.

APP="${APP_DIR:-/app}"
STOP_FILE=/tmp/asadmd.stopping
PID_FILE=/tmp/asadmd-node.pid
rm -f "$STOP_FILE" "$PID_FILE"

# Asad MD runs in the background and auto-restarts; it can never take Flask down.
(
  cd "$APP/asad-md" || exit 1
  while [ ! -f "$STOP_FILE" ]; do
    ASADMD_EMBEDDED=1 node src/index.js &
    echo $! > "$PID_FILE"
    wait $!
    code=$?
    [ -f "$STOP_FILE" ] && break
    echo "[start.sh] Asad MD exited (code $code), restarting in 30s"
    sleep 30
  done
) &
BOT_LOOP=$!

cd "$APP" || exit 1
gunicorn app:app --bind 0.0.0.0:${PORT:-10000} --workers 1 --threads 8 --timeout 120 &
WEB=$!

stop_bot() {
  touch "$STOP_FILE"
  if [ -f "$PID_FILE" ]; then kill -TERM "$(cat "$PID_FILE")" 2>/dev/null; fi
  i=0
  while kill -0 "$BOT_LOOP" 2>/dev/null && [ "$i" -lt 22 ]; do sleep 1; i=$((i + 1)); done
}

shutdown() {
  echo "[start.sh] stopping: asking the bot to save to the database first…"
  stop_bot
  kill -TERM "$WEB" 2>/dev/null
  wait "$WEB" 2>/dev/null
  exit 0
}
trap shutdown TERM INT

wait "$WEB"
code=$?
echo "[start.sh] web server exited (code $code)"
stop_bot
exit "$code"
