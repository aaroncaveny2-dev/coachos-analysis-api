FROM node:20-slim

RUN apt-get update && \
    apt-get install -y stockfish && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

RUN npm install

COPY . .

ENV STOCKFISH_PATH=/usr/games/stockfish
ENV STOCKFISH_DEPTH=14
ENV POLL_INTERVAL_MS=3000

CMD ["node", "src/index.mjs"]
