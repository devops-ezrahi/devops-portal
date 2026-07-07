# devops-portal deploy bundle

Self-contained export for testing the sidecar (oauth2-proxy + devops-portal in
one pod) deployment on a machine with real k3s/kubectl access. No Docker
build, no registry, no npm install needed on the target machine — everything
is pre-built.

## Contents

```
images/
  devops-portal.tar          # app image, built from this repo's Dockerfile
  oauth2-proxy.tar            # sidecar image, version pinned in the chart
manifests/
  namespace-and-secrets.yaml  # namespace + empty-placeholder secrets (chart excludes both)
  devops-portal.yaml          # configmap, sidecar deployment, service — rendered from chart/
load-and-deploy.sh             # applies namespace+secrets, then the chart manifest, imports images, rolls out
```

## Before running

`manifests/namespace-and-secrets.yaml` ships with **empty placeholders** for
`OAUTH2_PROXY_CLIENT_SECRET` and `OAUTH2_PROXY_COOKIE_SECRET` (the source
chart in this repo deliberately excludes Secrets with real values — see
CLAUDE.md). The oauth2-proxy sidecar will fail to start without a valid
cookie secret. Either:

- edit `manifests/namespace-and-secrets.yaml`'s `oauth2-proxy-secrets` Secret
  with real values before running the script, or
- apply the bundle once, then `kubectl edit secret oauth2-proxy-secrets -n devops-portal`
  and restart the deployment.

Generate a cookie secret with: `python3 -c 'import secrets,base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())'`

The OIDC issuer URL / client-id / public redirect URL baked into this
manifest come from `chart/values.yaml` (`externalUrl`, `oauth2Proxy.*`) at
render time — they default to this repo's homelab Keycloak. To target a
different Keycloak instance, don't hand-edit this file: rebuild the bundle
with an overlay instead (see `chart/values.closed-network.yaml.example` in
the source repo):

```bash
VALUES_FILE=chart/values.closed-network.yaml \
  bash .claude/skills/export-deploy-bundle/build-export.sh
```

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
