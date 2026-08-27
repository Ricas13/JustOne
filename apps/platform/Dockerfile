FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
ENV PLATFORM_PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.js"]
