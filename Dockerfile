################################################################################
# Dependencies — installed once and reused by the build and runtime stages.
################################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 falls back to compiling from source when no prebuild matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm install --include=dev

################################################################################
# Build — compile the shared contracts, the API and the dashboard.
################################################################################
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

################################################################################
# Runtime — Playwright browsers plus the compiled application.
################################################################################
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIR=/app/apps/api/public \
    HOST=0.0.0.0 \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates fonts-liberation tini curl \
 && rm -rf /var/lib/apt/lists/*

# Runtime dependency tree (dev packages pruned) and the compiled output.
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/apps/api/public ./apps/api/public

# Install the browser builds matching the Playwright version in node_modules.
RUN npx --yes playwright install --with-deps chromium firefox \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health/live || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
