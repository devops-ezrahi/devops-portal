# DevOps Customer Portal

Express + React + TypeScript + Vite portal intended for k8s deployment behind an SSO proxy (oauth2-proxy / Keycloak). The proxy injects `x-forwarded-user` / `x-forwarded-groups` headers; the server reads those to identify users and grant admin access.

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
      argocd/         # router.ts + service.ts
      branchdiff/     # router.ts + service.ts
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
- **Inject the data API into the router only when more than one implementation exists.** Ticketing (`JiraTicketingApi` / `InMemoryTicketingApi`) and Artifactory (`RealArtifactoryApi`) take an injected API instance — this keeps them swappable and unit-testable. Single-backend modules (`argocd`, `branchdiff`, `ragflow`) keep their logic in a sibling `service.ts` (or inline in the router for `ragflow`) that the router imports directly; no DI ceremony.
- `app.ts` selects the implementation by config, e.g. `config.jira.enabled ? new JiraTicketingApi(config.jira) : new InMemoryTicketingApi()`.

**Client** — `src/client/modules/<name>/`:
- `index.tsx` exports a `PortalModule` object (`id`, `userNav`, `adminNav`, `View`); add it to the `modules` array in `src/client/App.tsx`.
- `api.ts` holds **only this module's** fetch calls (built on the shared `request`/`requestFormData` helpers from `src/client/api.ts`).
- Sub-components live in `components/`, one per file — don't inline large components in the View.

The shell passes `refreshKey` as a prop; modules use it as a React `key` to remount and reload on the Refresh button.

## No mock data in production code

Shipped code must use real data sources only — no seed/demo data baked into modules. Test fixtures belong under `__tests__/` (e.g. `modules/ticketing/__tests__/seedTickets.ts`) and are injected into the in-memory API by tests, never loaded by default.

Two **intentional, temporary** exceptions remain for local dev/demo and are slated for replacement:
- `src/client/api.ts` `demoUsers` + role switcher, and the dev fallback user in `auth.ts` — let the app run locally without an SSO proxy in front.
- `branchdiff` reads fake YAML from `fake-repos/` instead of a real git checkout.

## Config & environment

Startup config is read from environment variables **once** via `src/server/config.ts`. Never read `process.env` directly in feature code — always go through the frozen `config` object. The one documented exception is `argocd`: it forwards the caller's auth per request and is configured at request time, so it centralizes its env reads in a single `configuredArgoCd()` function inside `modules/argocd/service.ts` (this also lets tests mutate `ARGOCD_*` at runtime).

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

Groups are pipe-separated (not comma) so LDAP-style DNs containing commas work.

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

After committing, push the branch to origin so work is backed up and reviewable.

```bash
git push -u origin <branch-name>   # first push on a new branch
git push                           # subsequent pushes
```

Run `npm run build` before pushing to catch type errors. Never force-push to `main`.

## Testing

```bash
npm test          # vitest run (unit + integration)
npm run build     # tsc --noEmit + vite build (type-check included)
```

Run `npm run build` before pushing to catch type errors.

## Deployment

The app expects to run in a container behind an SSO proxy. `Dockerfile` builds from `dist/`. `Jenkinsfile` defines the CI pipeline. In k8s, env vars come from a ConfigMap/Secret mounted as pod env vars — no `.env` file is used in production.
