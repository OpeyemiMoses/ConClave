FROM node:20-slim

# git is required at runtime — ingest.js shells out to `git clone` for every
# repo analysis. ca-certificates is required alongside it — node:20-slim
# doesn't ship CA certs, so git can't verify GitHub's TLS cert over HTTPS
# without it (fails with "server certificate verification failed").
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/server.js"]