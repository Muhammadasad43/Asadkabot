#!/bin/sh
# Asad MD runs in the background and auto-restarts; it can never take Flask down.
(
  cd /app/asad-md || exit 1
  while true; do
    ASADMD_EMBEDDED=1 node src/index.js
    code=$?
    echo "[start.sh] Asad MD exited (code $code), restarting in 30s"
    sleep 30
  done
) &

# Flask is the foreground process and owns Render's $PORT.
exec gunicorn app:app --bind 0.0.0.0:${PORT:-10000} --workers 1 --threads 8 --timeout 120
