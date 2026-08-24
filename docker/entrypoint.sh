#!/bin/sh
set -e

echo "=================================================="
echo "🐳 Starting Container Init Environment"
echo "=================================================="

# Ensure persistent volume ownership on cloud mounts
mkdir -p /app/data /var/lib/tor /var/log/tor
chown -R node:node /app/data
chown -R tor:tor /var/lib/tor /var/log/tor

# Check if Tor is enabled
if [ "$TOR_ENABLED" = "true" ] || [ "$TOR_ENABLED" = "1" ]; then
  echo "🧅 [1/3] Starting embedded Tor Daemon..."
  su-exec tor tor -f /etc/tor/torrc --runasdaemon 1

  echo "⏳ [2/3] Waiting for Tor SOCKS5 proxy readiness on 127.0.0.1:9050..."
  TOR_READY=0
  for i in $(seq 1 30); do
    if nc -z 127.0.0.1 9050 2>/dev/null; then
      echo "✅ Tor SOCKS5 proxy is ready and listening on 127.0.0.1:9050 (Attempt $i)"
      TOR_READY=1
      break
    fi
    sleep 1
  done

  if [ "$TOR_READY" -eq 0 ]; then
    echo "⚠️ Tor daemon did not become ready within 30s. Proceeding with failover..."
  fi
else
  echo "⚡ Tor is disabled in environment (TOR_ENABLED=false)."
fi

echo "🚀 [3/3] Launching Node.js Bot Application..."
# Execute Node.js as the unprivileged node user
exec su-exec node node dist/index.js
