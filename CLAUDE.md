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
    auth.ts           # SSO header parsing, 401 handling
    env.ts            # runtime env validation/defaults
    modules/
      ticketing/      # Ticketing module (router.ts + domain files)
      artifactory/    # Artifactory module
      ragflow/        # RAGflow module
  client/
    App.tsx           # thin shell: loads /api/me, renders nav, mounts active module View
    api.ts            # shared fetch helpers
    modules/
      ticketing/      # index.tsx (PortalModule def), api.ts, views, components
      artifactory/
      ragflow/
```

## Module pattern

Each feature is a self-contained module in two mirrored folders.

**Server** — create `src/server/modules/<name>/router.ts` exporting `create<Name>Router(api)`, then mount it in `src/server/app.ts`.

**Client** — create `src/client/modules/<name>/index.tsx` exporting a `PortalModule` object (`id`, `userNav`, `adminNav`, `View`), then add it to the `modules` array in `src/client/App.tsx`.

The shell passes `refreshKey` as a prop; modules use it as a React `key` to remount and reload on the Refresh button.

## Config & environment

All config is read from environment variables via `src/server/config.ts`. Never read `process.env` directly in feature code — always go through the config object.

Key variables (see `.env.example`):

| Variable | Default | Effect |
|---|---|---|
| `SSO_REQUIRED` | `false` | Enforce SSO proxy headers; returns 401 if absent |
| `SSO_URL` | — | SSO login URL sent to the client on 401 |
| `ADMIN_GROUP` | `portal-admins` | Group that grants admin access |
| `ARTIFACTORY_URL` / `ARTIFACTORY_REPO` / `ARTIFACTORY_TOKEN` | — | All three required to activate `RealArtifactoryApi`; otherwise `InMemoryArtifactoryApi` |

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
