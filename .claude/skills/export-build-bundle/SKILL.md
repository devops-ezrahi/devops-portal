---
name: export-build-bundle
description: Export a self-contained build-export.tar.gz (source code + node_modules, optionally the Dockerfile's base images) for building devops-portal on a machine with no npm registry / container registry access. Use when asked to package or bundle the source and dependencies for offline building.
---

Assembles `source/` (git-tracked source, via `git archive HEAD`) and
`node_modules/` (copied from this repo's own install, or a fresh `npm ci`
if none exists) — everything needed to run `npm run build` / `docker build`
without npm registry access. Optionally also pulls and saves the
Dockerfile's base images as tars, for a target with no container registry
access either. Everything is packed into a single `build-export.tar.gz` at
the repo root; the working directory it was assembled in is deleted
afterward, so only the tar is left behind.

## Run

```bash
bash .claude/skills/export-build-bundle/build-bundle.sh
```

Add `WITH_BASE_IMAGES=1` to also pack the Dockerfile's base images
(currently `oauth2-proxy`, `node:20-alpine`, `node:20-slim` — parsed from the
Dockerfile's `FROM` lines at run time, not hardcoded, so it stays correct if
the Dockerfile changes):

```bash
WITH_BASE_IMAGES=1 bash .claude/skills/export-build-bundle/build-bundle.sh
```

`build-export/` and `build-export.tar.gz` are gitignored (`/build-export/`
and `/build-export.tar.gz` in `.gitignore`) — `node_modules/` and any base
images are large and should never be committed.

## Assumptions / gotchas

- Does **not** run `npm run build` or `docker build` itself, and doesn't
  produce a `devops-portal` image — this skill only packages raw build
  inputs.
- `node_modules/` is copied as-is from this machine if present (not
  reinstalled) — fine if the target machine matches this one's OS/arch,
  risky otherwise (esbuild/rollup ship per-platform optional deps). Delete
  local `node_modules/` first to force a clean `npm ci` before packaging if
  targeting a different platform.
- Base-image pulling requires the Docker daemon reachable locally (on
  Windows, start Docker Desktop and wait ~30s if `docker version` fails) —
  it pulls each image if not already cached locally, then `docker save`s it.
- Stage names in the Dockerfile (`AS builder`, `AS production`, etc.) are
  filtered out before pulling, so a `FROM <earlier-stage>` line is never
  mistaken for a registry image to pull.
