---
name: export-deploy-bundle
description: Export a self-contained deploy-export/ bundle (app image + oauth2-proxy image as tars, current k3s manifests, and a load script) for testing the devops-portal k8s deployment on a machine with real kubectl/k3s access. Use when asked to export, package, or bundle the deployment for testing elsewhere.
---

Produces `deploy-export/` at the repo root: the `devops-portal` image and the
`oauth2-proxy` sidecar image saved as tars, a copy of the current
`k3s-homelab/manifests/devops-portal.yaml`, and a `load-and-deploy.sh` +
`README.md` for running it on a machine that actually has k3s/kubectl access
(this repo's dev environment may not — no registry push, no cluster
connectivity required to build the bundle itself).

## Run

```bash
bash .claude/skills/export-deploy-bundle/build-export.sh
```

This:
1. Verifies the Docker daemon is reachable (on Windows: start Docker Desktop
   first if it prints a connection error — it takes ~30s to come up).
2. Runs `npm run build` and the esbuild server-bundle step (same as
   `scripts/deploy-k3s.sh`).
3. `docker build`s `devops-portal:latest` from the repo's `Dockerfile`.
4. Reads the oauth2-proxy image tag out of
   `k3s-homelab/manifests/devops-portal.yaml` (so it never drifts from
   whatever the manifest actually pins) and `docker pull`s it.
5. Wipes and rewrites `deploy-export/` with both images as tars
   (`docker save`), a copy of the manifest, and the `load-and-deploy.sh` /
   `README.md` templates from `templates/` in this skill folder.

`deploy-export/` is gitignored (`/deploy-export/` in `.gitignore`) — the
image tars run 70-90MB combined and should never be committed.

## Assumptions / gotchas

- Assumes `k3s-homelab` is a sibling directory of this repo
  (`../k3s-homelab`), same convention as `scripts/deploy-k3s.sh`. Override
  with `HOMELAB_DIR=/path/to/k3s-homelab bash build-export.sh` if it lives
  elsewhere.
- The exported manifest's `oauth2-proxy-secrets` Secret carries whatever is
  currently checked into `k3s-homelab/manifests/devops-portal.yaml` —
  typically empty placeholders for `OAUTH2_PROXY_CLIENT_SECRET` /
  `OAUTH2_PROXY_COOKIE_SECRET`. The bundle's README calls this out; the
  oauth2-proxy sidecar won't start without a real cookie secret.
- If `docker version` fails, don't try to work around it — it means Docker
  Desktop isn't running in this environment. Say so and stop; starting it
  (Windows: `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
  via PowerShell, then poll `docker version` until it responds) is a
  reasonable next step if asked to proceed anyway.
