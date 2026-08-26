# Build dlhd-web from upstream and inject missing src/channels/m3u8.ts
# Upstream exports ./m3u8.js but never committed the file (TS2307 on npm run build).

FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git

RUN git clone --depth 1 https://github.com/Lunatic16/dlhd-web.git /app

# Missing module required by src/channels/index.ts and src/server/channels.ts
COPY m3u8.ts /app/src/channels/m3u8.ts

RUN npm ci && npm run build

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000
USER node
CMD ["node", "dist/server/index.js"]
