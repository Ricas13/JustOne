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

# Build upstream unchanged first. WebStreamrMBG enables a 30 requests/minute
# Express limiter in production; for JustOne this service is internal-only and
# platform-side maintenance traffic is already paced/cooldown-aware. Patch only
# the compiled Docker image so the provider checkout stays clean/fast-forwardable
# and upstream TypeScript can never fail because of our local limiter override.
# Require exactly one compiled limiter occurrence so upstream changes fail loudly
# instead of silently applying the patch to the wrong code.
RUN npm run build \
    && test "$(grep -o 'limit: 30' dist/index.js | wc -l)" -eq 1 \
    && sed -i 's/limit: 30/limit: Number(process.env.WEBSTREAMR_INTERNAL_RATE_LIMIT || 300)/' dist/index.js \
    && grep -Fq 'WEBSTREAMR_INTERNAL_RATE_LIMIT' dist/index.js \
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
