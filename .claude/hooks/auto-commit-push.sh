#!/bin/bash
# Stop hook: checkpoint-commit any working tree changes and push to origin, so
# work is backed up after every Claude Code turn.
#
# There used to be a second push to a `gitea` remote, which fed an in-cluster
# Gitea Actions -> registry -> ArgoCD pipeline. That whole chain was removed
# along with the Gitea instance; deploys are now a local
# ../homelab/scripts/deploy-portal.sh away, so this hook only backs up.
#
# The commit subject is Conventional Commits, because CI runs semantic-release
# off these subjects (.releaserc.json) — see the message generation below.
set -uo pipefail

# Set when this hook shells out to `claude -p` for the message. That nested
# session fires this same Stop hook, so without the guard it recurses forever.
[ -n "${AUTOCOMMIT_HOOK:-}" ] && exit 0

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

  # Let a cheap model read the staged diff and name the change, so the history
  # semantic-release consumes says what actually happened. The grep is the real
  # guard: prose, a refusal, or multi-line output all fall through to the
  # `chore:` fallback, which is valid Conventional Commits and non-releasable —
  # a bad generation can never mis-bump a version.
  msg="$(
    { git diff --cached --stat; echo; git diff --cached; } | head -c 40000 |
      AUTOCOMMIT_HOOK=1 timeout 90 claude -p \
        'Write ONE Conventional Commits subject line (max 72 chars) for this staged diff. Use feat: only for new user-facing capability and fix: only for a bug fix in shipped behaviour; use ci:/build:/test:/docs:/refactor: for those areas, and default to chore: whenever unsure. Add a scope only when the area is obvious. Output the subject line and nothing else.' \
        --model haiku --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
        2>/dev/null | tr -d '\r' |
      grep -m1 -E '^[a-z]+(\([a-z0-9._/-]+\))?!?: .+'
  )"
  [ "${#msg}" -gt 72 ] && msg=""
  [ -z "$msg" ] && msg="chore: checkpoint $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git commit -m "$msg" >/dev/null 2>&1
fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
  git push origin "$branch" >/dev/null 2>&1 || true
  # Push pack/* tags (created by the whitening packer) too.
  git push origin --tags >/dev/null 2>&1 || true
fi

exit 0
