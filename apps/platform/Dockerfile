FROM node:20-bookworm-slim
WORKDIR /app

# Live TV transport reliability matters more than a few MB of image size. Debian's
# FFmpeg build has broader HLS/protocol coverage than Alpine's musl package, and
# tini makes sure supervised FFmpeg children are reaped cleanly during restarts.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public

ENV PLATFORM_PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
