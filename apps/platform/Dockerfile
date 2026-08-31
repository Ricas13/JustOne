FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg git docker-cli docker-cli-compose
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
ENV PLATFORM_PORT=8080
ENV NODE_ENV=production
# Reliability-first default: keep VOD delivery on the same server-side path that
# admission validated. Users can still opt back into client handoff via .env.
ENV DIRECT_MEDIA_HANDOFF=false
EXPOSE 8080
CMD ["node", "src/index.js"]
