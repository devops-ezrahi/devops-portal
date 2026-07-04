#!/bin/bash
# Syncs optional real-backend secrets from the local .env into the
# devops-portal-secrets Secret in k3s. The bulk of the config (SSO_REQUIRED,
# ADMIN_GROUP, KEYCLOAK_*, ...) is checked into devops-portal's own
# chart/values.yaml and applied via ArgoCD/helm — this script only carries
# optional per-deployer secrets (Jira/Artifactory/Chat tokens) that aren't
# meant to live in git.
set -e

SKIP_RESTART=false
for arg in "$@"; do
  [ "$arg" = "--skip-restart" ] && SKIP_RESTART=true
done

PORTAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PORTAL_DIR/.env"
NAMESPACE="devops-portal"

if [ ! -f "$ENV_FILE" ]; then
  echo "==> No .env file found at $ENV_FILE, skipping secret sync."
  exit 0
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

kubectl create secret generic devops-portal-secrets \
  --namespace "$NAMESPACE" \
  --from-literal=JIRA_URL="${JIRA_URL:-}" \
  --from-literal=JIRA_TOKEN="${JIRA_TOKEN:-}" \
  --from-literal=JIRA_PROJECT_KEY="${JIRA_PROJECT_KEY:-}" \
  --from-literal=ARTIFACTORY_URL="${ARTIFACTORY_URL:-}" \
  --from-literal=ARTIFACTORY_REPO="${ARTIFACTORY_REPO:-}" \
  --from-literal=ARTIFACTORY_TOKEN="${ARTIFACTORY_TOKEN:-}" \
  --from-literal=CHAT_API_URL="${CHAT_API_URL:-}" \
  --from-literal=CHAT_API_KEY="${CHAT_API_KEY:-}" \
  --from-literal=CHAT_MODEL="${CHAT_MODEL:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

if [ "$SKIP_RESTART" = false ]; then
  kubectl rollout restart deployment/devops-portal -n "$NAMESPACE" 2>/dev/null || true
fi

echo "==> Secret devops-portal-secrets synced in namespace $NAMESPACE."
