FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js index.html manifest.json sw.js icon.png icon-192.png ./

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
