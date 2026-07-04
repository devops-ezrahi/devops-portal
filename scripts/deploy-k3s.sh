#!/bin/bash
set -e

PORTAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER="${DOCKER:-docker}"
TAG="dev-$(date +%s)"
IMAGE="localhost:5000/devops-portal:${TAG}"

cd "$PORTAL_DIR"

echo "==> Syncing .env → k3s ConfigMap/Secret..."
bash "$PORTAL_DIR/scripts/sync-env-to-k3s.sh" --skip-restart

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

echo "==> Building Docker image..."
if [ -f Dockerfile.update ] && "$DOCKER" image inspect "localhost:5000/devops-portal:latest" &>/dev/null; then
  "$DOCKER" build -f Dockerfile.update -t "$IMAGE" .
else
  "$DOCKER" build -f Dockerfile -t "$IMAGE" .
fi

echo "==> Pushing image to the in-cluster registry..."
"$DOCKER" push "$IMAGE"

echo "==> Deploying via helm..."
helm upgrade --install devops-portal ./chart -n devops-portal --create-namespace \
  --set image.tag="$TAG"
kubectl rollout status deployment/devops-portal -n devops-portal

echo ""
echo "Done. Portal: http://localhost:4180"
