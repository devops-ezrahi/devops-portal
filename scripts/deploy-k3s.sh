#!/bin/bash
set -e

PORTAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOMELAB_DIR="/home/ido/Desktop/k3s-homelab"
DOCKER="/snap/bin/docker"

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
if sudo "$DOCKER" image inspect devops-portal:latest &>/dev/null; then
  sudo "$DOCKER" build -f Dockerfile.update -t devops-portal:latest .
else
  sudo "$DOCKER" build -f Dockerfile -t devops-portal:latest .
fi

echo "==> Importing into k3s..."
sudo "$DOCKER" save devops-portal:latest | sudo k3s ctr images import -

echo "==> Applying manifests..."
kubectl apply -f "$HOMELAB_DIR/manifests/devops-portal/"
kubectl apply -f "$HOMELAB_DIR/manifests/oauth2-proxy.yaml"

echo "==> Restarting deployment..."
kubectl rollout restart deployment/devops-portal -n devops-portal
kubectl rollout status deployment/devops-portal -n devops-portal

echo ""
echo "Done. Portal: http://localhost:4180"
