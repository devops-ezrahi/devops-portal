#!/bin/bash
# Stop hook: checkpoint-commit any working tree changes and push to origin, so
# work is backed up after every Claude Code turn.
#
# There used to be a second push to a `gitea` remote, which fed an in-cluster
# Gitea Actions -> registry -> ArgoCD pipeline. That whole chain was removed
# along with the Gitea instance; deploys are now a local
# ../homelab/scripts/deploy-portal.sh away, so this hook only backs up.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
cd "$REPO_ROOT" || exit 0

STATUS="$(git status --porcelain 2>/dev/null)"

if [ -n "$STATUS" ]; then
  # Safety gate: this commit is fully unattended (no human reviews `git
  # status` before it runs, unlike a manual commit), so never auto-stage
  # anything that looks secret-related even though .gitignore already
  # excludes .env — this is a second, independent check.
  # ...but .env.example / .sample / .template are committed templates, not secrets — exclude them first.
  if echo "$STATUS" | grep -Ev '\.env\.(example|sample|template|dist)$' | grep -Eiq '\.env($|\.[^.]*$)|secret|credential|\.pem$|\.key$|id_rsa'; then
    echo '{"systemMessage": "Auto-commit/push skipped: a changed path looks secret-related. Review and commit it manually."}'
    exit 0
  fi
  git add -A
  git commit -m "auto: checkpoint $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null 2>&1
fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
  git push origin "$branch" >/dev/null 2>&1 || true
  # Push pack/* tags (created by the whitening packer) too.
  git push origin --tags >/dev/null 2>&1 || true
fi

exit 0
