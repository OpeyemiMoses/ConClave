FROM node:20-slim

# git is required at runtime — ingest.js shells out to `git clone` for every
# repo analysis. Nixpacks' default runtime image didn't reliably include it;
# a Dockerfile gives full explicit control instead of guessing at builder
# detection behavior.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/server.js"]