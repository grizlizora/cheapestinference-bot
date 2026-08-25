# ==========================================
# Stage 1: Build TypeScript Application
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

# Install native compilation dependencies for SQLite
RUN apk add --no-cache python3 make g++

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build && npm prune --omit=dev

# ==========================================
# Stage 2: Minimal Production Runtime
# ==========================================
FROM node:20-alpine AS runner
WORKDIR /app

# Install Tor, Tini init system, su-exec, and curl
RUN apk add --no-cache tor tini su-exec curl ca-certificates

# Setup directory ownership
RUN mkdir -p /app/data /var/lib/tor /var/log/tor /etc/tor \
    && chown -R node:node /app \
    && chown -R tor:tor /var/lib/tor /var/log/tor /etc/tor

# Copy tor configuration
COPY docker/torrc /etc/tor/torrc

# Copy compiled artifacts from builder stage
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=64 --max-semi-space-size=2 --optimize-for-size" \
    PORT=7860 \
    DB_PATH=/app/data/bot.db \
    TOR_ENABLED=true \
    TOR_SOCKS_HOST=127.0.0.1 \
    TOR_SOCKS_PORT=9050 \
    TOR_CONTROL_HOST=127.0.0.1 \
    TOR_CONTROL_PORT=9051

VOLUME ["/app/data"]
EXPOSE 7860

ENTRYPOINT ["/sbin/tini", "-g", "--", "/entrypoint.sh"]
