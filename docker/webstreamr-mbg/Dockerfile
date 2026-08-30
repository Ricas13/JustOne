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
RUN npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app

ENV NODE_ENV=production \
    PORT=51546 \
    CACHE_DIR=/cache

EXPOSE 51546
CMD ["node", "dist/index.js"]
