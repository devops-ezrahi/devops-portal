---
name: ship-to-homelab
description: Ship a devops-portal change through the real CI/CD path (Gitea Actions build+push, chart tag bump, ArgoCD sync) instead of the local fast-path deploy, and confirm it actually landed. Use when asked to deploy via the pipeline, verify CI/CD, or check whether a push made it to the cluster.
---

Covers the **real pipeline** path (`../homelab/CLAUDE.md` → SSO/OIDC and
Deployment sections), not local dev — for that, use the `run-devops-portal`
skill. This one is for "did my change actually reach the running pod",
end to end.

## 1. Push to Gitea's `main`

The workflow (`.gitea/workflows/deploy.yaml`) only triggers on
`push: branches: [main]`. The local `main` branch here is a stale,
divergent snapshot missing `chart/`/`Dockerfile`/`.gitea/` — `testing-v1`
(or whatever branch currently has the real infra) is the deployable one.
Push it to Gitea's `main` explicitly, don't assume local `main` is it:

```bash
npm run build                       # catch type errors before pushing
git push gitea <branch-name>:main   # e.g. git push gitea testing-v1:main
```

The `gitea` remote already points at `http://gitea_admin:...@gitea.homelab.local/gitea_admin/devops-portal.git`
(check with `git remote -v` if unsure).

## 2. Watch the Actions run

Simplest: open `http://gitea.homelab.local/gitea_admin/devops-portal/actions`
in a browser (needs the hosts-file entry from `../homelab/CLAUDE.md` →
Links).

Without a browser, tail the runner pod directly — the job runs inside its
DinD sidecar, so runner-container logs show `act_runner` picking up the job
and the workflow's own step output:

```bash
kubectl logs -f -n gitea deployment/act-runner -c runner --tail=100
```

Build step runs with `DOCKER_BUILDKIT=0` (classic builder — BuildKit's extra
network sandbox hits a TLS timeout on this DinD setup, see workflow
comments) and can take a few minutes. If it hangs far longer than a local
`npm run build` + `docker build` would, that's the known DinD MTU/BuildKit
gotcha, not a hang worth debugging fresh.

## 3. Confirm the chart tag bump landed

The workflow's last step clones `gitea_admin/homelab.git` and commits
`devops-portal/chart/values.yaml`'s bumped `image.tag` there (not to this
repo) as `chore: deploy devops-portal <sha>`. Confirm it arrived, from a
checkout of the `homelab` repo:

```bash
git fetch origin main
git log origin/main -1 --oneline    # expect "chore: deploy devops-portal <short-sha>"
```

If this commit never shows up, the pipeline failed before the last step —
go back to the Actions log, don't assume ArgoCD is broken yet.

## 4. Confirm ArgoCD synced and the pod is healthy

```bash
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
kubectl get application devops-portal -n argocd -o jsonpath='{.status.sync.status} {.status.health.status}{"\n"}'
kubectl rollout status deployment/devops-portal -n devops-portal
kubectl get pods -n devops-portal -o jsonpath='{.items[0].spec.containers[0].image}{"\n"}'
```

Expect `Synced Healthy` and the pod's image to be
`registry.homelab.local/devops-portal:<the sha from step 3>`. ArgoCD's
`selfHeal: true` (see `../homelab/argocd-apps/devops-portal.yaml`) means it
should sync automatically within its poll interval — no manual
`argocd app sync` needed. If it's stuck out of sync, check that Application
manifest before poking at the workload directly.

## 5. Verify in the browser

`http://devops-portal.homelab.local` — expect the SSO redirect to Keycloak
(oauth2-proxy in front) to work and the new change to be visibly present.

## If something's wrong mid-pipeline

- **Image push/pull fails**: the k3d node's containerd must trust
  `registry.homelab.local` — see `../homelab/registries.yaml` (a host file,
  requires `docker restart k3d-homelab-server-0` after editing, NOT
  `kubectl apply`).
- **Runner never picks up the job at all**: check the `act-runner` pod is
  actually `2/2 Running` in `-n gitea` — it needs the
  `act-runner-registration` Secret created by hand once (Gitea Admin →
  Actions → Runners), see `../homelab/manifests/gitea-runner.yaml` comments.
- **Don't reach for `scripts/deploy-k3s.sh`** to "fix" a broken CI deploy —
  that's the separate local fast-path (side-loads a `dev-<timestamp>` tag
  directly, bypassing the registry entirely) and will mask whatever the
  pipeline actually did.
