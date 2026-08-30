# Clone upstream dlhd-web and inject the local compatibility helpers.
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache git
RUN git clone --depth 1 https://github.com/Lunatic16/dlhd-web.git /app
COPY m3u8.ts /app/src/channels/m3u8.ts
COPY channels.ts /app/src/server/channels.ts
RUN npm ci && npm run build \
  && grep -q 'X-DLHD-Delivery' /app/dist/server/channels.js

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
