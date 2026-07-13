# DevOps Customer Portal

Express + React + TypeScript + Vite portal intended for k8s deployment fronted by oauth2-proxy (Keycloak OIDC), bundled into the same container image (see `Dockerfile` / `scripts/entrypoint.sh` — oauth2-proxy runs as a background process on :4180, proxying to the Express app on localhost:8080). The proxy injects `x-forwarded-user` / `x-forwarded-groups` headers; the server reads those to identify users and grant admin access.

OpenShift 4 deployment uses the same chart and the same `oauth2-proxy` (Keycloak OIDC) path as everywhere else — the real OS4 cluster provisions its Keycloak client via a platform CRD, not a manually-registered one. That CRD hands back a Secret with `client`/`secret`/`wellknown` keys; `../homelab/devops-portal/chart`'s `oauth2Proxy.credentialsSecretName` (see `values.openshift.yaml.example`) points at it, and `entrypoint.sh` derives `OAUTH2_PROXY_OIDC_ISSUER_URL` from the `wellknown` URL by stripping its `/.well-known/openid-configuration` suffix. There used to be an `os4-chart` using OpenShift's own OAuth server (a cluster-scoped `OAuthClient` + the bundled `origin-oauth-proxy` binary, selected via `AUTH_PROVIDER=openshift`) — deleted 2026-07-13 once it was confirmed the real cluster's Keycloak-CRD flow needs Keycloak-issued credentials, which fail token exchange silently if pointed at OpenShift's own OAuth server instead. `origin-oauth-proxy`, the `AUTH_PROVIDER` branch in `entrypoint.sh`, and `auth.ts`'s `groupsViaTokenReview` TokenReview fallback were removed 2026-07-13 once confirmed unreferenced by any chart.

## Dev setup

```bash
cp .env.example .env   # fill in values as needed
npm install
npm run dev            # starts Express on :3001 and Vite on :5173 concurrently
```

## Project structure

```
src/
  server/
    index.ts          # dev entry — loads dotenv, starts HTTP server
    index-prod.ts     # prod entry — no dotenv (env comes from k8s ConfigMap)
    app.ts            # Express app, mounts all module routers
    config.ts         # reads process.env once; all feature code consumes this object
    auth.ts           # SSO header parsing, group access control, admin check
    env.ts            # runtime env validation/defaults
    types.ts          # shared cross-module types (API interfaces, DTOs)
    modules/
      ticketing/      # router.ts + JiraTicketingApi.ts + InMemoryTicketingApi.ts + domain files
      artifactory/    # router.ts + RealArtifactoryApi.ts
      ragflow/        # router.ts (single real backend, reads config.chat)
  client/
    App.tsx           # thin shell: loads /api/me, renders nav, mounts active module View
    api.ts            # cross-cutting fetch helpers only (request, getMe, getPortalConfig, demo users)
    modules/
      <name>/
        index.tsx     # PortalModule def (id, userNav, adminNav, View)
        api.ts        # this module's fetch calls only
        <Name>View.tsx
        components/   # one file per sub-component
```

## Module pattern

Each feature is a self-contained module in two mirrored folders. **Conform new modules to this exact layout** so the codebase stays uniform.

**Server** — `src/server/modules/<name>/`:
- `router.ts` exports `create<Name>Router(...)` and is mounted in `src/server/app.ts`.
- The data layer lives **inside the module folder** — never add data files at `src/server/*.ts`.
- **Inject the data API into the router only when more than one implementation exists.** Ticketing (`JiraTicketingApi` / `InMemoryTicketingApi`) and Artifactory (`RealArtifactoryApi`) take an injected API instance — this keeps them swappable and unit-testable. Single-backend modules (`ragflow`) keep their logic in a sibling `service.ts` (or inline in the router for `ragflow`) that the router imports directly; no DI ceremony.
- `app.ts` selects the implementation by config, e.g. `config.jira.enabled ? new JiraTicketingApi(config.jira) : new InMemoryTicketingApi()`.

**Client** — `src/client/modules/<name>/`:
- `index.tsx` exports a `PortalModule` object (`id`, `userNav`, `adminNav`, `View`); add it to the `modules` array in `src/client/App.tsx`.
- `api.ts` holds **only this module's** fetch calls (built on the shared `request`/`requestFormData` helpers from `src/client/api.ts`).
- Sub-components live in `components/`, one per file — don't inline large components in the View.

The shell passes `refreshKey` as a prop; modules use it as a React `key` to remount and reload on the Refresh button.

## No mock data in production code

Shipped code must use real data sources only — no seed/demo data baked into modules. Test fixtures belong under `__tests__/` (e.g. `modules/ticketing/__tests__/seedTickets.ts`) and are injected into the in-memory API by tests, never loaded by default.

One **intentional, temporary** exception remains for local dev/demo and is slated for replacement:
- `src/client/api.ts` `demoUsers` + role switcher, and the dev fallback user in `auth.ts` — let the app run locally without an SSO proxy in front.

## Config & environment

Startup config is read from environment variables **once** via `src/server/config.ts`. Never read `process.env` directly in feature code — always go through the frozen `config` object.

Key variables (see `.env.example`):

| Variable | Default | Effect |
|---|---|---|
| `SSO_REQUIRED` | `false` | Enforce SSO proxy headers; returns 401 if absent |
| `SSO_URL` | — | SSO login URL sent to the client on 401 |
| `ALLOWED_GROUPS` | — | Pipe-separated groups allowed to use the portal at all (empty = allow everyone); 403 otherwise |
| `ADMIN_GROUP` | `portal-admins` | Pipe-separated groups that grant admin access |
| `ARTIFACTORY_URL` / `ARTIFACTORY_REPO` / `ARTIFACTORY_TOKEN` | — | All three required to activate `RealArtifactoryApi` |
| `JIRA_URL` / `JIRA_TOKEN` / `JIRA_PROJECT_KEY` | — | All three required to activate `JiraTicketingApi` (Jira Data Center, Bearer PAT); otherwise `InMemoryTicketingApi` fallback |
| `CHAT_API_URL` / `CHAT_API_KEY` | — | Both required to enable the chat proxy; otherwise `/api/ragflow/chat` returns 503 |

Groups are pipe-separated (not comma) so LDAP-style DNs containing commas work. Set `ALLOWED_GROUPS`/`ADMIN_GROUP` to plain group names (e.g. `devops-admins`), even when the IdP's groups claim sends full DNs (`CN=devops-admins,OU=...,DC=...`) — `auth.ts`'s `parseGroups` detects `CN=` and extracts just the CN for matching, since oauth2-proxy comma-joins multiple groups into one `X-Forwarded-Groups` header value and a naive split can't tell a group boundary from a comma inside a DN.

Adding a new env var: add to `.env.example`, expose it in `src/server/config.ts`, consume via the config object.

## Branching

Create a new branch when starting work on a distinct feature, fix, or refactor — especially before making changes that are non-trivial or unrelated to whatever branch is currently checked out.

```bash
git checkout -b feature/<short-description>   # new feature or module
git checkout -b fix/<short-description>       # bug fix
```

Use the existing branch only if the work is a direct continuation of what that branch already contains.

## Committing

Stage specific files — avoid `git add -A` (can accidentally include `.env` or build artifacts).

```bash
git add src/...         # stage only relevant source files
git status              # confirm nothing sensitive is staged
git commit -m "..."
```

Never commit `.env`, secrets, or files from `dist/` or `node_modules/`. These are covered by `.gitignore` but always verify with `git status` before committing.

Commit messages: imperative mood, ≤72 chars on the subject line. Describe _why_, not just what changed.

## Pushing

After committing, push the branch to origin so work is backed up and reviewable. Also push to the `gitea` remote (the in-cluster Gitea instance) — pushes that land on Gitea's `main` are what actually trigger the CI/CD pipeline (see Deployment below). A Stop hook does this automatically after every turn; the manual commands below are for pushing by hand.

```bash
git push -u origin <branch-name>   # first push on a new branch
git push                           # subsequent pushes
git push gitea <branch-name>:<branch-name>   # feed the Gitea Actions pipeline
```

Run `npm run build` before pushing to catch type errors. Never force-push to `main`.

## Testing

```bash
npm test          # vitest run (unit + integration)
npm run build     # tsc --noEmit + vite build (type-check included)
```

Run `npm run build` before pushing to catch type errors.

## Deployment

The app runs in a single container fronted by oauth2-proxy (bundled into the
same image, not a separate sidecar — see `scripts/entrypoint.sh`), deployed
onto the `k3d-homelab` cluster maintained in the sibling `../homelab` repo
(see that repo's `CLAUDE.md` and `CLUSTER.md` for cluster-wide setup —
Keycloak, Gitea, ArgoCD, hostnames). `Dockerfile` builds from `dist/`. The k8s Helm chart lives in
`../homelab/devops-portal/chart` (moved out of this repo on 2026-07-11 so
`homelab` is the single source of truth for infra) —
`chart/values.yaml` holds the image tag and portal config; Secrets are
deliberately not part of the chart (see below). In k8s, env vars come from a
ConfigMap/Secret mounted as pod env vars — no `.env` file is used in
production.

### Gitea Actions → in-cluster registry → ArgoCD

Push to `main` on the `gitea` remote (see "Pushing" below) and
`.gitea/workflows/deploy.yaml` takes it from there: builds the image with
`docker build`, then pushes it to the in-cluster registry
(`../homelab/manifests/registry.yaml`) at
`registry.homelab.local/devops-portal:<git-sha>`. The workflow then clones
`gitea_admin/homelab.git`, bumps `devops-portal/chart/values.yaml`'s
`image.tag` there, and commits+pushes that as a second, separate commit into
the `homelab` repo (same `GIT_PUSH_TOKEN`, since `gitea_admin` owns both
repos). ArgoCD (`../homelab/argocd-apps/devops-portal.yaml`) watches the
`homelab` repo's `devops-portal/chart` path and auto-syncs. No manual step
required once the pipeline is deployed and both repos are pushed to Gitea.

The runner (`../homelab/manifests/gitea-runner.yaml`) builds inside a
Docker-in-Docker sidecar rather than the host's docker.sock — this k3d
cluster's node was never created with that socket bind-mounted, and there's
no k3d CLI available in this environment to safely recreate it. DinD means
job containers are isolated from the k3d node's containerd, so (unlike the
homelab repo's mock services, side-loaded directly — see
`../homelab/scripts/01-build-mocks.sh`) this pipeline has to go through a
registry; the node's containerd separately needs to trust that registry to
pull the image (`../homelab/registries.yaml`, applied by hand, requires
restarting the `k3d-homelab-server-0` container). See that manifest file's
comments for the full reasoning.

There is no manual local deploy path — the Gitea Actions → registry → ArgoCD pipeline above is the only way code reaches the cluster. Secrets (`devops-portal-secrets`, `oauth2-proxy-secrets`) are never in the chart, so ArgoCD's `selfHeal` can never revert real values back to a Git-committed placeholder.

The portal is then live at **http://devops-portal.homelab.local** (oauth2-proxy → portal) — needs a hosts-file entry, see `../homelab/CLAUDE.md` → Links.

## Finishing a task

Always run every command needed to fully complete the task — don't stop at code changes and tell the user to do the rest. Concretely:

- After editing k8s manifests in `../homelab/`: `kubectl apply -f <file>` and wait for rollout (`kubectl rollout status …`).
- After changing server code: the dev server (`tsx watch`) reloads automatically — verify with the Playwright driver or a quick `node -e "fetch(…)"` probe.
- After changing client code: Vite HMR reloads automatically — take a screenshot with the driver to confirm the UI looks right.
- After changing `config.ts` or env vars: restart the dev server (`pkill -f "tsx watch"` then `npm run dev`) to pick up the new values.
- Run `npm run build` before any push to catch type errors.
