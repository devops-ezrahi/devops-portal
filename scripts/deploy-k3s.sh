#!/bin/bash
set -e

PORTAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER="${DOCKER:-docker}"
K3D_NODE="${K3D_NODE:-k3d-homelab-server-0}"
TAG="dev-$(date +%s)"
IMAGE="devops-portal:${TAG}"

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
if [ -f Dockerfile.update ] && "$DOCKER" image inspect "devops-portal:latest" &>/dev/null; then
  "$DOCKER" build -f Dockerfile.update -t "$IMAGE" .
else
  "$DOCKER" build -f Dockerfile -t "$IMAGE" .
fi

echo "==> Importing image into ${K3D_NODE}'s containerd (no registry needed) ..."
"$DOCKER" save "$IMAGE" | docker exec -i "$K3D_NODE" ctr -n k8s.io images import -

echo "==> Deploying via helm..."
# Chart lives in the homelab repo now (single source of truth for infra),
# expected as a sibling directory to this one.
helm upgrade --install devops-portal ../homelab/devops-portal/chart -n devops-portal --create-namespace \
  --set image.repository=devops-portal \
  --set image.tag="$TAG"
kubectl rollout status deployment/devops-portal -n devops-portal

echo ""
echo "Done. Portal: http://devops-portal.homelab.local (needs a hosts-file entry, see ../homelab/CLAUDE.md)"
