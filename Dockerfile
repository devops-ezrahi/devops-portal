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

# node:20-slim ships with an empty /etc/ssl/certs. oauth2-proxy is a Go binary
# and reads the system trust store, so without this it cannot verify ANY TLS
# certificate — OIDC discovery against an https:// issuer fails with "x509:
# certificate signed by unknown authority" and the proxy exits, which surfaces
# as a 502 from the ingress rather than an obvious crash. This went unnoticed
# while the cluster served plain HTTP.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Research module's engine. Installed globally, invoked as a child process
# per question (see src/server/modules/research/RealResearchApi.ts).
RUN npm install -g opencode-ai

# --create-home (not the previous --no-create-home): the Research module's
# opencode config and skill discovery both live under ~ for whichever repo
# opencode is pointed at (opencode.json's permission block, and any skills
# ConfigMap mounted at ~/.claude/skills — see homelab chart). ENV HOME is set
# explicitly rather than relying on useradd's default, so that path is fixed.
RUN groupadd --system appgroup && useradd --system --gid appgroup --create-home appuser
ENV HOME=/home/appuser
RUN mkdir -p /home/appuser/.config/opencode
COPY docker/opencode.json /home/appuser/.config/opencode/opencode.json
RUN chown -R appuser:appgroup /home/appuser

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
