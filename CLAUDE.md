# DevOps Customer Portal

Express + React + TypeScript + Vite portal intended for k8s deployment fronted by oauth2-proxy (Keycloak OIDC), bundled into the same container image (see `Dockerfile` / `scripts/entrypoint.sh` — oauth2-proxy runs as a background process on :4180, proxying to the Express app on localhost:8080). The proxy injects `x-forwarded-user` / `x-forwarded-groups` headers; the server reads those to identify users and grant admin access.

OpenShift 4 deployment uses this same `oauth2-proxy`/Keycloak path, not OpenShift's own OAuth server — the real OS4 cluster's Keycloak CRD hands back Keycloak-issued credentials (`values.openshift.yaml.example` in the chart), which fail token exchange silently against OpenShift's native OAuth. (An earlier OpenShift-native path — `os4-chart`, `origin-oauth-proxy`, `AUTH_PROVIDER`, `auth.ts`'s TokenReview fallback — was removed for this reason.)

`build-export.tar.gz.png` at the repo root is intentionally named `.png` — not a mistake, not a misnamed archive. Don't flag or question this filename.

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

| Variable                                                     | Default         | Effect                                                                                                                      |
| ------------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `SSO_REQUIRED`                                               | `false`         | Enforce SSO proxy headers; returns 401 if absent                                                                            |
| `SSO_URL`                                                    | —               | SSO login URL sent to the client on 401                                                                                     |
| `ALLOWED_GROUPS`                                             | —               | Pipe-separated groups allowed to use the portal at all (empty = allow everyone); 403 otherwise                              |
| `ADMIN_GROUP`                                                | `portal-admins` | Pipe-separated groups that grant admin access                                                                               |
| `ARTIFACTORY_URL` / `ARTIFACTORY_REPO` / `ARTIFACTORY_TOKEN` | —               | All three required to activate `RealArtifactoryApi` (REST — `HEAD` to check, `PUT` to upload; no `jf` CLI)                  |
| `ARTIFACTORY_DOCKER_REPO`                                    | —               | Docker repo the Whitening module pushes retagged images to via `skopeo`                                                     |
| `GIT_URL` / `GIT_TOKEN`                                      | —               | Bitbucket Server base URL + HTTP access token; required for the Whitening module to open pull requests                      |
| `GIT_USERNAME`                                               | —               | Empty (default) puts the token alone in the clone URL; set it only if Bitbucket wants `username:token` basic auth           |
| `JIRA_URL` / `JIRA_TOKEN` / `JIRA_PROJECT_KEY`               | —               | All three required to activate `JiraTicketingApi` (Jira Data Center, Bearer PAT); otherwise `InMemoryTicketingApi` fallback |
| `CHAT_API_URL` / `CHAT_API_KEY`                              | —               | Both required to enable the chat proxy; otherwise `/api/ragflow/chat` returns 503                                           |

`whitening.json` at the repo root is read by the whitening packer, not by the app, and now
holds only `images: false`. **Department, team and repository come from the CI job that
runs the packer** (`WHITENING_*` env vars in `.github/workflows/ci.yml`'s `pack` step) —
the packer writes them into the pack's `repository/config.json`, which is what the
Whitening module reads (never the filename).

Groups are pipe-separated (not comma) so LDAP-style DNs containing commas work. Set `ALLOWED_GROUPS`/`ADMIN_GROUP` to plain group names (e.g. `devops-admins`), even when the IdP's groups claim sends full DNs (`CN=devops-admins,OU=...,DC=...`) — `auth.ts`'s `parseGroups` detects `CN=` and extracts just the CN for matching, since oauth2-proxy comma-joins multiple groups into one `X-Forwarded-Groups` header value and a naive split can't tell a group boundary from a comma inside a DN.

Adding a new env var: add to `.env.example`, expose it in `src/server/config.ts`, consume via the config object.

## Branching

Create a new branch when starting work on a distinct feature, fix, or refactor — especially before making changes that are non-trivial or unrelated to whatever branch is currently checked out.

```bash
git checkout -b feature/<short-description>   # new feature or module
git checkout -b fix/<short-description>       # bug fix
```

Use the existing branch only if the work is a direct continuation of what that branch already contains.

Two long-lived branches: `main` is the stable release channel, `dev` is the
prerelease channel (`1.1.0-dev.1`, …). Push to either cuts a release — see
Versioning & releases below.

## Committing

Stage specific files — avoid `git add -A` (can accidentally include `.env` or build artifacts).

```bash
git add src/...         # stage only relevant source files
git status              # confirm nothing sensitive is staged
git commit -m "..."
```

Never commit `.env`, secrets, or files from `dist/` or `node_modules/`. These are covered by `.gitignore` but always verify with `git status` before committing.

Commit messages: **Conventional Commits**, ≤72 chars on the subject line, imperative mood. The body is where you describe _why_.

| Subject                                | Release effect |
| -------------------------------------- | -------------- |
| `feat: …`                              | minor bump     |
| `fix: …`                               | patch bump     |
| `feat!: …` / `BREAKING CHANGE:` footer | major bump     |
| `chore:` `docs:` `test:` `refactor:` `build:` `ci:` `style:` `perf:` | patch bump |
| anything else (merge commits, non-conventional subjects) | patch bump |

CI runs semantic-release off these subjects, so the type is not cosmetic — it
decides how far the version moves. There is no "no release" any more: patch is
the floor (see Versioning & releases), so `chore:` means "don't call this a
feature", not "don't ship this".

The Stop hook's auto-commits follow the same convention: it posts the staged
diff to the Messages API (Haiku 4.5) to name the change, and falls back to
`chore: checkpoint <ts>` if that fails or returns anything that isn't a valid
subject line.

That call needs `ANTHROPIC_API_KEY` in the environment — **without it every
auto-commit is a bare `chore: checkpoint`**. Set it in the `env` block of
`.claude/settings.local.json`, which is gitignored:

```json
{ "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } }
```

It calls the API directly rather than shelling out to `claude -p`, which booted
the whole CLI harness (~30k tokens of system prompt, tool definitions and this
file) to write one line — ~$0.025 and ~11s on every single turn.

## Pushing

After committing, push the branch to origin so work is backed up and reviewable. A Stop hook does this automatically after every turn; the manual commands below are for pushing by hand.

```bash
git push -u origin <branch-name>   # first push on a new branch
git push                           # subsequent pushes
```

Pushing is backup only — it does not deploy anything. See Deployment below.

Never force-push to `main`.

## Testing

```bash
npm test          # vitest run (unit + integration)
npm run build     # tsc --noEmit + vite build (type-check included)
```

## Versioning & releases

**Never hand-edit `package.json`'s `version`.** semantic-release owns it. It
runs in CI's `pack` job (`.releaserc.json`) on every push to `main` or `dev`,
reads the Conventional Commit subjects since the last `v*` tag, and then:

1. writes the new version into `package.json` / `package-lock.json`,
2. commits that back as `chore(release): <version> [skip ci]`,
3. tags `v<version>` (`v1.2.0-dev.3` on `dev`) and cuts the GitHub release.

It runs **before** the whitening pack step and in the same workspace, because
`pack.py` reads `package.json` off disk to name the tgz
(`dem-devops-portal-<version>.tgz`), and the `v<version>` release it just cut is
where CI uploads that tgz as an asset. Both channels produce packs.

**One version = one tag = one release.** There are no `pack/*` tags any more —
the packer creates none, and deltas its dependency bundle against the previous
release tag. (Old `pack/*` tags and releases from before this predate the
change; nothing reads them.)

Every push to `main`/`dev` releases: `.releaserc.json`'s `releaseRules` floor
every commit at **patch**, including merge commits and anything with no
Conventional Commit type at all. `feat:` still outranks the floor to minor and
`feat!:`/`BREAKING CHANGE:` to major — the `!` form only works because of
`parserOpts.breakingHeaderPattern`; the angular preset's own header pattern
doesn't parse `!` and used to drop those commits on the floor entirely — so
typing commits honestly still decides
how far the version moves — it just can't produce "no release" any more. That
also means work committed straight to `dev` cuts a prerelease per push; keep
using feature branches (CI only fires on `main`/`dev`) so the version climbs
per merge instead of per turn.

So the "bundle" flow is just: land Conventional Commits on `dev` or `main`, and
CI does bump → build → pack.

## Deployment

The app runs in a single container fronted by oauth2-proxy (bundled into the
same image — see `scripts/entrypoint.sh`), deployed onto the `k3d-homelab`
cluster maintained in the sibling `../homelab` repo (see that repo's
`CLAUDE.md` for cluster-wide setup). The `Dockerfile` is self-building from
source — the builder stage runs `npm run build` itself, and `.dockerignore`
excludes `dist/`, so no prebuilt output is handed to it. The Helm chart lives in
`../homelab/devops-portal/chart` (homelab is the single source of truth for
infra) — Secrets are deliberately not part of the chart. In k8s, env vars come
from a ConfigMap/Secret — no `.env` file in production.

### Deploying — push to `main` or `dev`

That is the whole thing. The `pack` job in `.github/workflows/ci.yml`:

1. semantic-release cuts the version,
2. builds and pushes `ghcr.io/devops-ezrahi/devops-portal:<version>` — pushing
   needs only `github.token` + `packages: write`, no secret to rotate; the
   package is private, so *pulling* needs the `ghcr-pull` Secret that External
   Secrets builds in the cluster (`../homelab/manifests/external-secrets.yaml`),
3. whitening-packs and uploads the tgz to the release,
4. commits that tag into `devops-portal/chart/values.yaml` on **homelab's
   `main`**, using the `HOMELAB_TOKEN` secret — `github.token` is scoped to this
   repo and cannot push cross-repo.

ArgoCD watches homelab `main` with `automated: {selfHeal: true}` and a 180s
reconcile, so step 4 is the deploy. Commit to pod is roughly four minutes.

**One PAT drives both halves, and it lives in two places.** The same classic
token is the `HOMELAB_TOKEN` Actions secret here *and* Vault's
`secret/homelab/github` `GITHUB_TOKEN` (from which ESO builds `ghcr-pull` for
the kubelet and `repo-homelab` for ArgoCD) — rotating it means updating both or
half the pipeline breaks silently. It needs **`repo` *and* `read:packages`**:
`repo` alone pushes to homelab fine and then every image pull dies in
`ImagePullBackOff` with a bare `403 Forbidden`, which reads like a broken image
rather than a missing scope. After writing a new token to Vault, force the
resync instead of waiting out the 1h `refreshInterval`:

```bash
kubectl -n devops-portal annotate externalsecret ghcr-pull force-sync=$(date +%s) --overwrite
kubectl -n argocd       annotate externalsecret repo-homelab force-sync=$(date +%s) --overwrite
```

The portal is then live at **https://portal.\<LAB_DOMAIN\>** — the domain is
set in `../homelab/lab.env`. No hosts-file entry; the hostname is public DNS.

### The shortcut, when four minutes is too long

```bash
../homelab/scripts/deploy-portal.sh
```

It reads the tag the Deployment currently asks for, builds the working tree
under *that* tag, and `k3d image import`s it into the node's containerd, so
`imagePullPolicy: IfNotPresent` finds it locally and never reaches ghcr.io.
ArgoCD sees no diff, so it neither fights nor undoes the swap — the local image
stays in front of that tag until the next release moves it. This is a local
override, not a release: nothing about it is reproducible from git.

> There used to be a Gitea Actions → in-cluster registry → ArgoCD pipeline.
> That was removed and is not what came back — this one publishes to GHCR and
> the "GitOps" half is a single `sed` + commit into homelab. Instructions
> elsewhere mentioning `git push gitea`, `act-runner`, or
> `registry.homelab.local` are stale.

## Finishing a task

Always run every command needed to fully complete the task — don't stop at code changes and tell the user to do the rest. Concretely:

- After editing k8s manifests in `../homelab/`: `kubectl apply -f <file>` and wait for rollout (`kubectl rollout status …`).
- After changing server code: the dev server (`tsx watch`) reloads automatically — verify with the Playwright driver or a quick `node -e "fetch(…)"` probe.
- After changing client code: Vite HMR reloads automatically — take a screenshot with the driver to confirm the UI looks right.
- After changing `config.ts` or env vars: restart the dev server (`pkill -f "tsx watch"` then `npm run dev`) to pick up the new values.
- Run `npm run build` before any push to catch type errors.
