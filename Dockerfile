FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends stockfish \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV STOCKFISH_PATH=/usr/games/stockfish

EXPOSE 3001

CMD ["node", "server.js"]
