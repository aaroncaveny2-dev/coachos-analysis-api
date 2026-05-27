FROM node:20-slim

RUN apt-get update && apt-get install -y stockfish

WORKDIR /app

COPY package.json ./

RUN npm install

COPY . .

CMD ["npm", "start"]
