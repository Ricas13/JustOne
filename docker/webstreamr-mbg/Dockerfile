FROM node:22-bookworm-slim AS build

ARG WEBSTREAMR_MBG_REF=main
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Build directly from the upstream project so JustOne does not fork or vendor it.
RUN git init \
    && git remote add origin https://github.com/newman2x/WebStreamrMBG.git \
    && git fetch --depth 1 origin "${WEBSTREAMR_MBG_REF}" \
    && git checkout --detach FETCH_HEAD

RUN npm ci \
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
    CACHE_DIR=/cache

EXPOSE 51546
CMD ["node", "dist/index.js"]
