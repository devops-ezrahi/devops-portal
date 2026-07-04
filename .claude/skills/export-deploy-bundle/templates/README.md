# devops-portal deploy bundle

Self-contained export for testing the sidecar (oauth2-proxy + devops-portal in
one pod) deployment on a machine with real k3s/kubectl access. No Docker
build, no registry, no npm install needed on the target machine — everything
is pre-built.

## Contents

```
images/
  devops-portal.tar    # app image, built from this repo's Dockerfile
  oauth2-proxy.tar      # sidecar image, version pinned in manifests/devops-portal.yaml
manifests/
  devops-portal.yaml    # namespace, configmap, secrets, sidecar deployment, service
load-and-deploy.sh       # imports both images + applies manifests + rolls out
```

## Before running

`manifests/devops-portal.yaml` ships with **empty placeholders** for
`OAUTH2_PROXY_CLIENT_SECRET` and `OAUTH2_PROXY_COOKIE_SECRET` (same as the
source manifest in `k3s-homelab/`). The oauth2-proxy sidecar will fail to
start without a valid cookie secret. Either:

- edit `manifests/devops-portal.yaml`'s `oauth2-proxy-secrets` Secret with
  real values before running the script, or
- apply the bundle once, then `kubectl edit secret oauth2-proxy-secrets -n devops-portal`
  and restart the deployment.

Generate a cookie secret with: `python3 -c 'import secrets,base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())'`

The Keycloak issuer URL baked into the manifest assumes the same homelab
cluster topology described in `k3s-homelab/CLUSTER.md` — update
`--oidc-issuer-url` / `--client-id` in the oauth2-proxy container args if
testing against a different Keycloak instance.

## Running

On the machine with kubectl/k3s access:

```bash
bash load-and-deploy.sh
```

Then verify:

```bash
kubectl get pods -n devops-portal          # expect devops-portal pod 2/2 Ready
kubectl port-forward --address 127.0.0.1 svc/devops-portal -n devops-portal 4180:4180
```

Open http://localhost:4180 — you should be redirected to Keycloak, then land
on the portal with `x-forwarded-*` headers populated by the sidecar.
