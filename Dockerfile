# syntax=docker/dockerfile:1
# Thumbdrive MCP: one image, one /data volume, one port.
#
#   docker build -t thumbdrive-mcp .
#   docker run -d --name thumbdrive -e THUMBDRIVE_HOST=0.0.0.0 \
#     -p 127.0.0.1:8484:8484 -v thumbdrive-data:/data thumbdrive-mcp
#   docker exec -it thumbdrive node dist/admin.js key create my-agent --folder /
#
# Secure by default: without THUMBDRIVE_HOST the server listens only on the
# container's own localhost, so nothing outside the container can reach it,
# even with a published port. Set THUMBDRIVE_HOST=0.0.0.0 and choose where
# to publish: 127.0.0.1:8484:8484 for this machine only, 8484:8484 for the LAN.
# For anything beyond the LAN, put HTTPS (Caddy, Cloudflare Tunnel) in front.

# Build stages run on the build machine's own architecture. Every runtime
# dependency is plain JavaScript, so their output works on amd64 and arm64.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    THUMBDRIVE_IN_CONTAINER=1 \
    PORT=8484 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE NOTICE README.md ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8484) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/index.js"]
