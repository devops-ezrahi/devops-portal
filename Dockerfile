FROM quay.io/oauth2-proxy/oauth2-proxy:v7.6.0 AS oauth2proxy

FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build

RUN npx esbuild src/server/index-prod.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node20 \
    --outfile=dist/server/index-prod.js \
    --external:express \
    --external:cors \
    --external:zod \
    --external:multer

FROM node:20-slim AS production

RUN groupadd --system appgroup && useradd --system --gid appgroup --no-create-home appuser

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/client ./dist/client
COPY --from=builder /app/dist/server/index-prod.js ./dist/server/index-prod.js
COPY --from=oauth2proxy /bin/oauth2-proxy /usr/local/bin/oauth2-proxy
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER appuser

# oauth2-proxy (:4180) fronts the app (:8080, localhost-only, no Service
# exposes it) — see /entrypoint.sh. Same request flow as the old sidecar pod,
# just one container now.
EXPOSE 4180

ENV PORT=8080
ENV NODE_ENV=production

ENTRYPOINT ["/entrypoint.sh"]
