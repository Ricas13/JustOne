FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# The source checkout is maintained by JustOne's updater at
# providers/webstreamr-mbg. Building from that checkout ensures a successful
# git pull is the exact code that gets deployed.
COPY providers/webstreamr-mbg/package.json providers/webstreamr-mbg/package-lock.json ./
RUN npm ci

COPY providers/webstreamr-mbg/ ./

# Upstream WebStreamrMBG enables a 30 requests/minute Express limiter whenever
# NODE_ENV=production. That is appropriate for a public hosted add-on, but this
# container is internal-only and all traffic is already governed by JustOne's
# background pacing/cooldown logic. Patch only that limiter in the build copy;
# keep the source checkout clean so provider auto-updates remain fast-forwardable.
# Fail the build if upstream changes the expected expression so this cannot
# silently stop applying after a provider update.
RUN grep -Fq 'addon.use(rateLimit({ windowMs: 60 * 1000, limit: 30 }));' src/index.ts \
    && sed -i 's/limit: 30/limit: Number(process.env.WEBSTREAMR_INTERNAL_RATE_LIMIT || 300)/' src/index.ts \
    && npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app

ENV NODE_ENV=production \
    PORT=51546 \
    CACHE_DIR=/cache \
    WEBSTREAMR_INTERNAL_RATE_LIMIT=300

EXPOSE 51546
CMD ["node", "dist/index.js"]
