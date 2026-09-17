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
#
# unzip is for the Whitening module's .zip packs. The tgz path uses tar, which
# is already here, but Debian's tar is GNU tar and cannot read zip at all —
# only Windows dev appears to work without this, because tar.exe there is
# bsdtar. Dropping unzip breaks .zip uploads in the cluster and nowhere else.
#
# maven + a headless JRE and python3-pip are the Artifactory module's dependency
# resolvers for a URL copy with "Include dependencies" ticked. Running the real
# client is the only honest way to do this: a pom needs parent chasing,
# dependencyManagement, property interpolation, BOM imports, ranges, exclusions
# and nearest-wins, and a wheel's Requires-Dist needs PEP 508 markers and version
# backtracking. Hand-rolling either lands at ~85% correct, and the 15% is a repo
# that installs fine until it doesn't.
#
# Both are optional at runtime — toolDependencies.ts probes for them and copies
# the single artifact when they are absent — so this line can be reverted
# without breaking the module.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git unzip maven openjdk-17-jre-headless python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Pre-warm maven-dependency-plugin into a baked local repository. Without this
# every URL copy fetches ~50 plugin files through the *source* repository's
# mirror — slow in an open network, and a hard failure in a closed one whose
# mirror does not proxy plugins. resolveMavenDependencies copies this per job
# rather than using it in place, so two concurrent jobs never share a writable
# local repo.
# No -ntp: it landed in Maven 3.6.1, and an older mvn dies on it with a usage
# dump. This base pins a newer one, but the runtime pods have been seen on 3.5.3.
RUN mvn -B -Dmaven.repo.local=/opt/m2 \
      org.apache.maven.plugins:maven-dependency-plugin:3.6.1:help

# AI module's engine. Installed globally, invoked as a child process
# per question (see src/server/modules/ai/RealAiApi.ts).
RUN npm install -g opencode-ai

# --create-home (not the previous --no-create-home): opencode keeps its session
# store and scratch state under ~, and the default AI_SKILLS_DIR is
# ~/.claude/skills. ENV HOME is set explicitly rather than relying on useradd's
# default, so that path is fixed.
# The read-only permission policy is NOT a file here any more — it's inlined in
# RealAiApi.ts and passed via OPENCODE_CONFIG, so a missing/overwritten
# config file can't silently re-grant write access.
# The uid/gid are pinned rather than distro-assigned because the chart mounts a
# PVC and sets `fsGroup` to match — an unpinned gid there is a silent
# permission-denied on the volume.
RUN groupadd --system --gid 10001 appgroup \
    && useradd --system --uid 10001 --gid appgroup --create-home appuser
ENV HOME=/home/appuser
RUN chown -R appuser:appgroup /home/appuser /opt/m2

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
