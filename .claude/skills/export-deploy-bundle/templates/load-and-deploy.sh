#!/bin/bash
# Self-contained deploy: loads the exported image into the local k3s
# containerd store and applies the manifests. Run this on the machine that
# actually has kubectl/k3s access (this bundle carries no external
# dependencies — no registry pull, no npm/docker build needed).
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Importing devops-portal image into k3s containerd..."
sudo k3s ctr images import "$DIR/images/devops-portal.tar"

echo "==> Applying namespace + placeholder secrets..."
kubectl apply -f "$DIR/manifests/namespace-and-secrets.yaml"

echo "==> Applying chart manifests (config, deployment, service)..."
kubectl apply -f "$DIR/manifests/devops-portal.yaml"

echo "==> Rolling out..."
kubectl rollout restart deployment/devops-portal -n devops-portal
kubectl rollout status deployment/devops-portal -n devops-portal

echo ""
echo "Done. Port-forward to test:"
echo "  kubectl port-forward --address 127.0.0.1 svc/devops-portal -n devops-portal 4180:4180"
echo "  open http://localhost:4180"
