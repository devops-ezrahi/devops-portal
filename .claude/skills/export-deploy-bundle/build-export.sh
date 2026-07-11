#!/bin/bash
# Builds deploy-export/: a self-contained bundle (app image as a tar —
# oauth2-proxy is bundled into it, see Dockerfile — manifests rendered from
# the devops-portal Helm chart, and a load script) that can be handed to any
# machine with real kubectl/k3s access, with no registry, npm, docker build,
# or helm required there. See SKILL.md.
set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PORTAL_DIR="$(cd "$SKILL_DIR/../../.." && pwd)"
DOCKER="${DOCKER:-docker}"
HELM="${HELM:-helm}"
OUT_DIR="$PORTAL_DIR/deploy-export"

cd "$PORTAL_DIR"

echo "==> Checking Docker daemon..."
if ! "$DOCKER" version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "Docker daemon not reachable." >&2
  echo "On Windows: start Docker Desktop and wait ~30s for it to come up, then re-run this script." >&2
  exit 1
fi

echo "==> Checking helm..."
if ! "$HELM" version >/dev/null 2>&1; then
  echo "helm not found. Install it (e.g. 'winget install --id Helm.Helm -e' on Windows) and re-run." >&2
  exit 1
fi

echo "==> Building client..."
npm run build

echo "==> Building server bundle..."
npx esbuild src/server/index-prod.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node20 \
    --outfile=dist/server/index-prod.js \
    --external:express \
    --external:cors \
    --external:zod \
    --external:multer

echo "==> Building devops-portal image..."
"$DOCKER" build -f Dockerfile -t devops-portal:latest .

echo "==> Assembling $OUT_DIR ..."
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/images" "$OUT_DIR/manifests"

echo "==> Rendering chart (registry-free: image.pullPolicy=Never, side-loaded tag)..."
VALUES_ARGS=()
if [ -n "${VALUES_FILE:-}" ]; then
  echo "    overlaying $VALUES_FILE (externalUrl / oauth2Proxy / config for this target network)"
  VALUES_ARGS=(-f "$VALUES_FILE")
fi
"$HELM" template devops-portal "$PORTAL_DIR/../homelab/devops-portal/chart" -n devops-portal \
  "${VALUES_ARGS[@]}" \
  --set image.repository=devops-portal \
  --set image.tag=latest \
  --set image.pullPolicy=Never \
  > "$OUT_DIR/manifests/devops-portal.yaml"

echo "==> Saving devops-portal image..."
"$DOCKER" save devops-portal:latest -o "$OUT_DIR/images/devops-portal.tar"

cp "$SKILL_DIR/templates/namespace-and-secrets.yaml" "$OUT_DIR/manifests/namespace-and-secrets.yaml"
cp "$SKILL_DIR/templates/load-and-deploy.sh" "$OUT_DIR/load-and-deploy.sh"
cp "$SKILL_DIR/templates/README.md" "$OUT_DIR/README.md"
chmod +x "$OUT_DIR/load-and-deploy.sh"

echo ""
echo "Done. Bundle contents:"
du -h "$OUT_DIR"/images/* "$OUT_DIR"/manifests/* "$OUT_DIR"/*.sh "$OUT_DIR"/*.md 2>/dev/null
