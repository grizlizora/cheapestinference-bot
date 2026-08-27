#!/bin/sh
set -e

echo "=================================================="
echo "🐳 Starting Container Init Environment"
echo "=================================================="

IS_ROOT=0
if [ "$(id -u)" = "0" ]; then
  IS_ROOT=1
fi

# Ensure persistent volume ownership on cloud mounts
mkdir -p /app/data /var/lib/tor /var/log/tor 2>/dev/null || true
if [ "$IS_ROOT" -eq 1 ]; then
  chown -R node:node /app/data 2>/dev/null || true
  chown -R tor:tor /var/lib/tor /var/log/tor 2>/dev/null || true
fi

# Check if Tor is enabled
if [ "$TOR_ENABLED" = "true" ] || [ "$TOR_ENABLED" = "1" ]; then
  echo "🧅 [1/2] Starting embedded Tor Standby Daemon in background..."
  if [ "$IS_ROOT" -eq 1 ]; then
    su-exec tor tor -f /etc/tor/torrc --runasdaemon 1
  else
    tor -f /etc/tor/torrc --runasdaemon 1 2>/dev/null || echo "⚠️ Tor startup in non-root mode, proceeding..."
  fi
else
  echo "⚡ Tor is disabled in environment (TOR_ENABLED=false)."
fi

echo "🚀 [2/2] Launching Node.js Bot Application (Fast-Path Active)..."
if [ "$IS_ROOT" -eq 1 ]; then
  exec su-exec node --optimize-for-size dist/index.js
else
  exec node --optimize-for-size dist/index.js
fi
