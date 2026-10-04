# Multi-stage build for the Mineflayer MCP server.
#
# Note: this server speaks MCP over stdio, so it's normally spawned by an MCP
# client. A container is most useful for a headless, autonomous deployment with
# a configured default account (MCP_DEFAULT_* env vars) — it connects on start
# and is driven by a client that attaches to its stdio, or run for side effects.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: skip the `prepare` lifecycle (it runs the build, but src
# isn't present yet); we build explicitly below once sources are copied.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# OCI / MCP-registry metadata.
LABEL org.opencontainers.image.source="https://github.com/G0Osey99/awesome-mineflayer-mcp" \
      org.opencontainers.image.description="MCP server for standalone-equivalent control of a Mineflayer Minecraft bot." \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.G0Osey99/awesome-mineflayer-mcp"

COPY package.json package-lock.json ./
# --ignore-scripts so `prepare` (build) doesn't run here (dist is copied from the
# build stage, and devDeps like typescript aren't installed under --omit=dev).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

# Persist the config + Microsoft auth token cache across restarts by mounting a
# volume here (override with AWESOME_MINEFLAYER_MCP_HOME).
VOLUME ["/root/.awesome-mineflayer-mcp"]

ENTRYPOINT ["node", "dist/index.js"]
