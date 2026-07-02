#!/bin/bash
set -e

PORTAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOMELAB_DIR="/home/ido/Desktop/k3s-homelab"
DOCKER="/snap/bin/docker"
IMAGE_LOCAL="devops-portal:latest"
IMAGE_REMOTE="registry.localhost:5000/devops-portal:latest"

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
if sudo "$DOCKER" image inspect "$IMAGE_LOCAL" &>/dev/null; then
  sudo "$DOCKER" build -f Dockerfile.update -t "$IMAGE_LOCAL" .
else
  sudo "$DOCKER" build -f Dockerfile -t "$IMAGE_LOCAL" .
fi

echo "==> Pushing to local registry..."
sudo "$DOCKER" tag "$IMAGE_LOCAL" "$IMAGE_REMOTE"
sudo "$DOCKER" push "$IMAGE_REMOTE"

echo "==> Applying manifests..."
kubectl apply -f "$HOMELAB_DIR/manifests/devops-portal/"
kubectl apply -f "$HOMELAB_DIR/manifests/oauth2-proxy.yaml"

echo "==> Restarting deployment..."
kubectl rollout restart deployment/devops-portal -n devops-portal
kubectl rollout status deployment/devops-portal -n devops-portal

echo ""
echo "Done. Portal: http://localhost:4180"
