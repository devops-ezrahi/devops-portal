---
name: export-deploy-bundle
description: Export a self-contained deploy-export/ bundle (app image + oauth2-proxy image as tars, current k3s manifests, and a load script) for testing the devops-portal k8s deployment on a machine with real kubectl/k3s access. Use when asked to export, package, or bundle the deployment for testing elsewhere.
---

Produces `deploy-export/` at the repo root: the `devops-portal` image and the
`oauth2-proxy` sidecar image saved as tars, manifests rendered from this
repo's own `chart/` (registry-free: `image.pullPolicy=Never`, tag `latest`,
side-loaded into containerd — no in-cluster registry needed for this bundle),
and a `load-and-deploy.sh` + `README.md` for running it on a machine that
actually has k3s/kubectl access (this repo's dev environment may not — no
cluster connectivity required to build the bundle itself; helm IS required
locally to render the chart).

## Run

```bash
bash .claude/skills/export-deploy-bundle/build-export.sh
```

This:
1. Verifies the Docker daemon is reachable (on Windows: start Docker Desktop
   first if it prints a connection error — it takes ~30s to come up) and that
   `helm` is on PATH.
2. Runs `npm run build` and the esbuild server-bundle step (same as
   `scripts/deploy-k3s.sh`).
3. `docker build`s `devops-portal:latest` from the repo's `Dockerfile`.
4. Renders `chart/` via `helm template` with `image.repository=devops-portal
   image.tag=latest image.pullPolicy=Never` (registry-free, matching how the
   bundle is loaded on the target machine) and reads the oauth2-proxy image
   tag out of that rendered output (so it never drifts from whatever the
   chart actually pins) before `docker pull`ing it. Pass
   `VALUES_FILE=chart/values.closed-network.yaml` to overlay a different
   network's `externalUrl` / `oauth2Proxy.oidcIssuerUrl` / `oauth2Proxy.clientId`
   (see `chart/values.closed-network.yaml.example`) without touching
   `chart/values.yaml`, which stays the homelab pipeline's default.
5. Wipes and rewrites `deploy-export/` with both images as tars
   (`docker save`), the rendered manifest, and the `load-and-deploy.sh` /
   `README.md` templates from `templates/` in this skill folder.

`deploy-export/` is gitignored (`/deploy-export/` in `.gitignore`) — the
image tars run 70-90MB combined and should never be committed.

## Assumptions / gotchas

- No longer depends on the sibling `k3s-homelab` repo at all — the chart
  that used to live at `k3s-homelab/manifests/devops-portal.yaml` now lives
  in this repo's own `chart/` (see CLAUDE.md's Deployment section), and this
  skill renders straight from it.
- The chart itself defines no Namespace and no Secrets (see CLAUDE.md —
  Secrets with real values are managed out-of-band, and the Namespace comes
  from `helm --create-namespace` / ArgoCD normally). This bundle has neither,
  so `templates/namespace-and-secrets.yaml` supplies both as a separate file,
  applied before the rendered chart manifest — always with **empty
  placeholders** for `OAUTH2_PROXY_CLIENT_SECRET` / `OAUTH2_PROXY_COOKIE_SECRET`.
  The bundle's README calls this out; the oauth2-proxy sidecar won't start
  without a real cookie secret.
- If `docker version` fails, don't try to work around it — it means Docker
  Desktop isn't running in this environment. Say so and stop; starting it
  (Windows: `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
  via PowerShell, then poll `docker version` until it responds) is a
  reasonable next step if asked to proceed anyway.
