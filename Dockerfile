# Thumbdrive MCP: one image, one /data volume, one port.
#
#   docker build -t thumbdrive-mcp .
#   docker run --init -p 127.0.0.1:8484:8484 -v "$PWD/data:/data" thumbdrive-mcp
#
# The port is published on localhost only. Put HTTPS (Caddy, Cloudflare Tunnel)
# in front before exposing it anywhere else.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8484 \
    BIND_HOST=0.0.0.0 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8484) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "src/index.ts"]
