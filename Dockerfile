# Single container: Express serves the API, Overland ingest, static frontend and tile cache.
# Lightweight Node.js build for Raspberry Pi 5 (ARM64) and x86_64
FROM node:22-alpine3.24 AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html server.ts ./
COPY src ./src
COPY server ./server
COPY shared ./shared
# Server is bundled with its deps, so the runtime image needs no node_modules
RUN npm run build
# Node ships with debug symbols; stripping saves ~17 MB
RUN apk add --no-cache binutils && strip -o /app/node /usr/local/bin/node

# Plain Alpine plus the Node binary: no npm/yarn/corepack, and no base layers to delete them from
FROM alpine:3.24
RUN apk add --no-cache libstdc++
COPY --from=build /app/node /usr/local/bin/node

ARG APP_UID=1001
ARG APP_GID=1001
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/dist ./dist
# Owned by the app user so a fresh tile-cache volume is writable
RUN mkdir -p data cache/tiles && chown -R ${APP_UID}:${APP_GID} data cache

EXPOSE 3000
CMD ["node", "dist/server.cjs"]
