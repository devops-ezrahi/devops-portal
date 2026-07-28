---
name: ship-to-homelab
description: Deploy a devops-portal change to the homelab cluster and confirm it actually landed in the running pod. Use when asked to deploy, ship, or verify that a change reached the cluster.
---

Deployment is one script. This skill is for "did my change actually reach the
running pod", end to end. For local dev, use the `run-devops-portal` skill
instead.

> This used to describe a Gitea Actions → in-cluster registry → ArgoCD
> pipeline. That whole chain was removed: it existed only to move a
> locally-built image onto a locally-running cluster. If you find instructions
> anywhere referring to `git push gitea`, the `act-runner` pod, or an ArgoCD
> `Application` for this app, they are stale.

## 1. Build and deploy

```bash
npm run build                        # catch type errors first
../homelab/scripts/deploy-portal.sh  # docker build -> k3d image import -> helm upgrade -> rollout restart
```

The script does the `rollout restart` itself, and that step is load-bearing:
the image tag is always `local` with `imagePullPolicy: IfNotPresent`, so
without it the kubelet keeps running the image it already has and the deploy
silently does nothing.

## 2. Confirm the pod actually restarted

```bash
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
kubectl rollout status deployment/devops-portal -n devops-portal
kubectl get pods -n devops-portal -o jsonpath='{.items[0].status.startTime}{"\n"}'
```

A start time older than your build means the restart didn't take — re-run the
script rather than debugging the app.

## 3. Verify in the browser

`https://portal.<LAB_DOMAIN>` (see `../homelab/lab.env`). Expect the SSO
redirect to Keycloak, then the change visibly present.

## If something's wrong

- **Image didn't change**: confirm `k3d image import` succeeded — it is silent
  on partial failures. `docker exec k3d-homelab-server-0 ctr -n k8s.io images ls
  | grep devops-portal` should show a recent timestamp.
- **TLS / cert errors**: not an app problem. See `../homelab/CLAUDE.md` → TLS.
- **SSO redirect loops or 500s**: almost always the issuer URL resolving
  differently for the pod than for the browser. See `../homelab/CLAUDE.md` →
  SSO / OIDC.
