#!/bin/bash
# Builds build-export/: source code + node_modules (and optionally the
# Dockerfile's base images), for building this app on a machine with no
# npm registry / container registry access. See SKILL.md.
#
# Deliberately does NOT run npm run build, docker build, or produce a
# devops-portal image itself — this skill only packages the raw inputs a
# build would need offline.
set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PORTAL_DIR="$(cd "$SKILL_DIR/../../.." && pwd)"
DOCKER="${DOCKER:-docker}"
OUT_DIR="$PORTAL_DIR/build-export"

cd "$PORTAL_DIR"

echo "==> Assembling $OUT_DIR ..."
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/source"

echo "==> Archiving source (git-tracked files only, HEAD)..."
git archive HEAD | tar -x -C "$OUT_DIR/source"

echo "==> Packaging node_modules..."
if [ -d "$PORTAL_DIR/node_modules" ]; then
  # ponytail: reuses whatever's already installed rather than forcing a
  # fresh `npm ci` — fine as long as it's installed on the same OS/arch as
  # the target machine (native deps like esbuild/rollup ship per-platform
  # optional packages). Force a clean reinstall first if targeting a
  # different platform, or if you don't trust local node_modules to match
  # package-lock.json.
  cp -r "$PORTAL_DIR/node_modules" "$OUT_DIR/node_modules"
else
  echo "    no local node_modules found, running npm ci..."
  npm ci
  cp -r "$PORTAL_DIR/node_modules" "$OUT_DIR/node_modules"
fi

if [ -n "${WITH_BASE_IMAGES:-}" ]; then
  echo "==> Checking Docker daemon..."
  if ! "$DOCKER" version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    echo "Docker daemon not reachable." >&2
    echo "On Windows: start Docker Desktop and wait ~30s for it to come up, then re-run this script." >&2
    exit 1
  fi

  echo "==> Packing base images referenced by Dockerfile..."
  mkdir -p "$OUT_DIR/base-images"

  # Collect every `AS <stage>` name so a `FROM <stage>` referencing an
  # earlier build stage (not a real registry image) never gets treated as
  # one to pull.
  declare -A STAGE_NAMES
  while read -r line; do
    as_name=$(echo "$line" | grep -oiE '\bAS[[:space:]]+[^[:space:]]+' | awk '{print $2}')
    [ -n "$as_name" ] && STAGE_NAMES["$as_name"]=1
  done < <(grep -E '^FROM' Dockerfile)

  while read -r line; do
    img=$(echo "$line" | awk '{print $2}')
    if [ -n "${STAGE_NAMES[$img]:-}" ]; then
      continue
    fi
    echo "    pulling $img ..."
    "$DOCKER" pull "$img"
    safe_name=$(echo "$img" | tr '/:@' '___')
    echo "    saving $img -> base-images/$safe_name.tar ..."
    "$DOCKER" save "$img" -o "$OUT_DIR/base-images/$safe_name.tar"
  done < <(grep -E '^FROM' Dockerfile)
fi

echo "==> Packing $OUT_DIR into a single tar..."
tar -czf "$PORTAL_DIR/build-export.tar.gz" -C "$PORTAL_DIR" build-export

echo ""
echo "Done. Bundle contents:"
du -sh "$OUT_DIR"/source "$OUT_DIR"/node_modules "$OUT_DIR"/base-images 2>/dev/null || true
echo ""
echo "Tar: $PORTAL_DIR/build-export.tar.gz"
du -sh "$PORTAL_DIR/build-export.tar.gz"
