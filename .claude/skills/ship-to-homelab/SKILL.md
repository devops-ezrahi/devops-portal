---
name: ship-to-homelab
description: Deploy a devops-portal change to the homelab cluster and confirm it actually landed in the running pod. Use when asked to deploy, ship, or verify that a change reached the cluster.
---

Deployment is a push. This skill is for "did my change actually reach the
running pod", end to end. For local dev, use the `run-devops-portal` skill
instead.

Pick a lane first:

- **Releasing** — push to `main` or `dev`. CI builds the image, publishes it to
  GHCR, and commits the tag into homelab's `main`, which ArgoCD syncs. Use §1.
- **Iterating** — you want the running pod to show a working-tree change in
  under a minute and don't want a version cut for it. Use §1b.

## 1. Release: push and follow it

```bash
npm run build   # catch type errors first
git push        # to main or dev; nothing else fires CI
gh run watch
```

Then follow the tag from CI into the cluster:

```bash
VERSION=$(gh release view --json tagName -q .tagName)   # v1.2.3-dev.4
git -C ../homelab log --oneline -1 origin/main          # chore: portal image 1.2.3-dev.4
kubectl -n argocd get app devops-portal                 # Synced / Healthy
```

ArgoCD reconciles every 180s. To stop waiting:

```bash
kubectl -n argocd patch app devops-portal --type merge -p '{"operation":{"sync":{}}}'
```

## 1b. Iterate: side-load over the current tag

```bash
npm run build
../homelab/scripts/deploy-portal.sh
```

It reads the tag the Deployment already asks for, builds the working tree under
that tag, `k3d image import`s it, and restarts. `IfNotPresent` then finds it
locally instead of pulling from ghcr.io. ArgoCD sees no diff, so it will not
undo this — but nothing about it is in git, and the next release replaces it.

## 2. Confirm the pod actually restarted

```bash
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
kubectl rollout status deployment/devops-portal -n devops-portal
kubectl -n devops-portal get pod -o jsonpath='{.items[0].spec.containers[0].image}{"\n"}'
kubectl get pods -n devops-portal -o jsonpath='{.items[0].status.startTime}{"\n"}'
```

A start time older than your build means the deploy didn't take.

## 3. Verify in the browser

`https://portal.<LAB_DOMAIN>` (see `../homelab/lab.env`). Expect the SSO
redirect to Keycloak, then the change visibly present.

## If something's wrong

- **`ImagePullBackOff`**: the GHCR package went private again, or CI wrote a tag
  it never actually pushed. `docker logout ghcr.io && docker pull <the image>`
  reproduces exactly what the kubelet is doing.
- **Pod still on the old tag**: ArgoCD hasn't reconciled yet, or CI's homelab
  commit step failed — check the tail of the `pack` job and
  `git -C ../homelab log --oneline -1 origin/main`.
- **Side-loaded image didn't take** (§1b): confirm `k3d image import` succeeded
  — it is silent on partial failures. `docker exec k3d-homelab-server-0 ctr -n
  k8s.io images ls | grep devops-portal` should show a recent timestamp.
- **TLS / cert errors**: not an app problem. See `../homelab/CLAUDE.md` → TLS.
- **SSO redirect loops or 500s**: almost always the issuer URL resolving
  differently for the pod than for the browser. See `../homelab/CLAUDE.md` →
  SSO / OIDC.
