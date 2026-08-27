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
      artifactory/    # router.ts + RealArtifactoryApi.ts + devSimulation.ts
      whitening/      # router.ts + RealWhiteningApi.ts + devSimulation.ts
      ai/             # router.ts + RealAiApi.ts (clones a registered repo, asks opencode CLI)
      jenkinsfile/    # router.ts + PipelineStore.ts (saved pipeline documents, no jobs)
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
- **Inject the data API into the router only when more than one implementation exists.** Ticketing (`JiraTicketingApi` / `InMemoryTicketingApi`), Artifactory (`RealArtifactoryApi`), Whitening (`RealWhiteningApi`) and AI (`RealAiApi`) take an injected API instance — this keeps them swappable and unit-testable. Jenkinsfile is the counter-example: one implementation, nothing to select on, so `createJenkinsfileRouter()` constructs its own `PipelineStore` (with a `dataDir` parameter for tests) and `app.ts` passes nothing.
- `app.ts` selects the implementation by config, e.g. `config.jira.enabled ? new JiraTicketingApi(config.jira) : new InMemoryTicketingApi()`.

**Client** — `src/client/modules/<name>/`:

- `index.tsx` exports a `PortalModule` object (`id`, `userNav`, `adminNav`, `View`); add it to the `modules` array in `src/client/App.tsx`.
- `api.ts` holds **only this module's** fetch calls (built on the shared `request`/`requestFormData` helpers from `src/client/api.ts`).
- Sub-components live in `components/`, one per file — don't inline large components in the View.

The shell passes `refreshKey` as a prop; modules use it as a React `key` to remount and reload on the Refresh button.

## No mock data in production code

Shipped code must use real data sources only — no seed/demo data baked into modules. Test fixtures belong under `__tests__/` (e.g. `modules/ticketing/__tests__/seedTickets.ts`) and are injected into the in-memory API by tests, never loaded by default.

Two **intentional** exceptions remain, both for local dev/demo and both gated on
the same signal (`SSO_REQUIRED` is not `true` — no proxy in front):

- The dev role switcher in `src/client/App.tsx` (`POST /api/dev/role`) and the dev fallback user in `auth.ts` — let the app run locally without an SSO proxy in front.
- `modules/artifactory/devSimulation.ts` + `modules/whitening/devSimulation.ts` — scripted runs behind the **Test** button each module shows in dev. Nothing is seeded: the job lists start empty, and a run only exists once you press it. Both routers mount `POST /api/<module>/jobs/simulate` only when `SSO_REQUIRED` is not `true`, and the client only renders the button for the `dev` user. The scripts drive the real job map, log, progress and abort controller, so Stop works on them too. `src/server/devSimulate.test.ts` pins that the routes 404 once SSO is required.

## Config & environment

Startup config is read from environment variables **once** via `src/server/config.ts`. Never read `process.env` directly in feature code — always go through the frozen `config` object.

Key variables (see `.env.example`):

| Variable                                                     | Default         | Effect                                                                                                                      |
| ------------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`                                                  | `info`          | `debug` \| `info` \| `warn` \| `error`. Everything goes to stdout (one stream, so ordering survives). `info` is one line per mutation, per 4xx/5xx, per slow (>1s) request, plus every job-log line mirrored with its job id — `kubectl logs \| grep ART-0007` reconstructs a run. `debug` adds successful GETs (the lists poll every 2-8s per open tab) and per-call Artifactory/Jira/Bitbucket detail. |
| `SSO_REQUIRED`                                               | `false`         | Enforce SSO proxy headers; returns 401 if absent                                                                            |
| `SSO_URL`                                                    | —               | SSO login URL sent to the client on 401                                                                                     |
| `SSO_NAME_HEADER`                                            | —               | Header the proxy carries the IdP's `name` claim in (the person's full name, not the username). Unset = fall back to `X-Forwarded-Preferred-Username`. Node parses header bytes as latin-1, so `auth.ts` re-decodes non-ASCII names (Hebrew, accents) as UTF-8 when that is what they are. The proxy must be configured to pass the claim through — that half lives in the homelab chart, not here. |
| `ALLOWED_GROUPS`                                             | —               | Pipe-separated groups allowed to use the portal at all (empty = allow everyone); 403 otherwise                              |
| `ADMIN_GROUP`                                                | `portal-admins` | Pipe-separated groups that grant admin access                                                                               |
| `ARTIFACTORY_URL` / `ARTIFACTORY_REPO` / `ARTIFACTORY_TOKEN` | —               | All three required to activate `RealArtifactoryApi` (REST — `HEAD` to check, `PUT` to upload; no `jf` CLI)                  |
| `ARTIFACTORY_DOCKER_REPO`                                    | —               | Docker repo the Whitening module pushes retagged images to via `skopeo`                                                     |
| `ARTIFACTORY_MAVEN_REPO` / `_RPM_REPO` / `_PYPI_REPO` / `_CONDA_REPO` | —       | Per-type repos the Artifactory module routes detected artifacts to (`packageTypes.ts`); unset = that type is skipped with a log line |
| `NPM_SOURCE_TOKEN`                                            | —               | Credential for the *source* npm registry when a URL copy is submitted with **Include dependencies** ticked. That path derives the registry from the pasted tarball URL (`<registry>/<name>/-/<file>.tgz`), writes it plus this token into a throwaway `.npmrc`, and runs a real `npm install` — once per target platform, since optional deps are platform-gated. Unset is normal: a public registry needs nothing, and a source registry on the same host as `ARTIFACTORY_URL` reuses `ARTIFACTORY_TOKEN` automatically. |
| `GIT_URL` / `GIT_TOKEN`                                      | —               | Bitbucket Server base URL + HTTP access token; required for the Whitening module to open pull requests. The AI module reuses the same token to authenticate `git clone` for registered `ai-*` project repos (unset = clone stays unauthenticated, so public repos still work) |
| `GIT_USERNAME`                                               | —               | Empty (default) puts the token alone in the clone URL; set it only if Bitbucket wants `username:token` basic auth           |
| `JIRA_URL` / `JIRA_TOKEN` / `JIRA_PROJECT_KEY`               | —               | All three required to activate `JiraTicketingApi` (Jira Data Center, Bearer PAT); otherwise `InMemoryTicketingApi` fallback |
| `JIRA_STORY_POINTS_FIELD`                                    | —               | Custom-field id holding story points (e.g. `customfield_10016`) — instance-specific; unset = points stay portal-only and are not synced to Jira |
| `AI_SKILLS_DIR`                                               | `~/.claude/skills` | Where the AI module's project registry lives — one `ai-<name>/SKILL.md` per repo (frontmatter `description` + a `Repo:` line, plus a free-text body describing how to work with that repo). This app's own code reads `description`/`Repo:` for the picker UI and the clone step (opencode has no bash access, so it can't clone itself) — but opencode's own native skill-discovery reads the *same* files: each question is prefixed "Use the ai-\<project\> skill", and opencode loads the SKILL.md body itself via its `skill` tool. That discovery is fixed to a few paths opencode always scans (`~/.claude/skills`, `~/.config/opencode/skills`, `~/.agents/skills`, plus project-level equivalents) — keep `AI_SKILLS_DIR` pointed at one of those (the default already is) or the portal's picker still works but opencode's `skill` tool won't find the project when asked to use it. The module activates once at least one `ai-*` entry is found there. The server logs the resolved path and the project count at startup, because an empty registry is otherwise indistinguishable from a wrong path. |
| `OPENCODE_API_KEY`                                            | —               | `OPENCODE_MODEL` (default `anthropic/claude-sonnet-5`) picks the provider — the env var opencode reads for credentials is derived from it (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) and set from `OPENCODE_API_KEY`. Leave `OPENCODE_API_KEY` empty for opencode's own free `opencode/*-free` models — they reject a non-empty placeholder as an invalid key. |
| `OPENCODE_BASE_URL`                                           | —               | Points the provider at a gateway/proxy instead of its public endpoint. opencode exposes no env var for this, so the server writes it into the opencode config it already generates for the read-only policy, as `provider.<id>.options.baseURL` — `<id>` is the provider half of `OPENCODE_MODEL`, so set the two together. |
| `DATA_DIR`                                                    | OS temp dir     | Where job history, the AI repo clones and opencode's session store are kept. In the cluster this is the PVC mount (`/data`); the tmpdir default is purely so local dev runs with an empty `.env`. Everything under it is derived (`<DATA_DIR>/{artifactory,whitening,ai}`, `<DATA_DIR>/clones`), so there is no second path var. See **Job persistence** below. |
| `AI_ARCHIVE_AFTER_HOURS`                                      | `4`             | Idle hours before a chat folds into the client's collapsed **Archived** list. `updatedAt` is the clock — every question restamps it, so asking in an archived chat un-archives it and the repo clone is re-pulled as usual. The sweep runs on read (inside `listConversations`), not on a timer. The topbar's **Archive** button (`POST /api/ai/conversations/:id/archive`) does the same stamp early, by hand. Un-archiving belongs to `submitQuestion`, not to the sweep — a chat archived by hand was just used, so any "clear the flag when not idle" rule would undo the click on the next read. Archiving never moves `updatedAt`, because that is what the client sorts by. Set to `0` to watch it work without waiting. **Nothing is ever deleted** — chats and jobs live under `DATA_DIR`, so there is no memory to reclaim by dropping them. |

`whitening.json` at the repo root is read by the whitening packer, not by the app, and now
holds only `images: false`. **Department, team and repository come from the CI job that
runs the packer** (`WHITENING_*` env vars in `.github/workflows/ci.yml`'s `pack` step) —
the packer writes them into the pack's `repository/config.json`, which is what the
Whitening module reads (never the filename).

Groups are pipe-separated (not comma) so LDAP-style DNs containing commas work. Set `ALLOWED_GROUPS`/`ADMIN_GROUP` to plain group names (e.g. `devops-admins`), even when the IdP's groups claim sends full DNs (`CN=devops-admins,OU=...,DC=...`) — `auth.ts`'s `parseGroups` detects `CN=` and extracts just the CN for matching, since oauth2-proxy comma-joins multiple groups into one `X-Forwarded-Groups` header value and a naive split can't tell a group boundary from a comma inside a DN.

Adding a new env var: add to `.env.example`, expose it in `src/server/config.ts`, consume via the config object.

## Job persistence

All three job-running modules (artifactory, whitening, ai) keep their history on
disk under `DATA_DIR`, one JSON file per job, via the shared `src/server/jobStore.ts`.
**Memory holds only what is in flight**, plus a summary of every job with `log`
stripped — which is what the list endpoints serve.

- The split works because `patch`, `appendLog` and `aborted` are only ever called
  on a *running* job (every `cancelJob` returns early on a finished one), so
  `JobStore.get` stays synchronous over the live map and no mutation path had to
  change shape.
- **Two writes per job, never one per log line**: `add()` at creation and
  `settle()` in each `run()`'s `finally`, after the last `appendLog`. Writing on
  every log line would rewrite a growing file per subprocess stdout line.
- Writes are serialised through one queue per store and go via temp-file +
  rename, so a crash mid-write cannot leave a torn file that kills the next boot.
- At boot the store reads every job file back. Anything still `pending` or
  `in-progress` on disk died with the last process, so it is rewritten as
  `failed — Interrupted by a server restart`; ids resume past the highest on disk
  rather than restarting at `0001`.
- `GET /api/<module>/jobs` returns log-free jobs; the drawer fetches the full one
  from `GET /api/<module>/jobs/:id`. That is why both Views hold the open job in
  its own state instead of reading it out of the list array.
- **Nothing is ever deleted.** Artifactory's old `MAX_JOBS` cap and the AI
  module's 48h delete are both gone. A chat is ~40 KB and opencode's own session
  is ~5-10 KB, so the volume holds tens of thousands. If it ever fills, delete
  files on it.

opencode's session store must live on the same volume: the portal keeps only
`conversation.opencodeSessionId`, and the transcript that id points at is
opencode's SQLite DB under `~/.local/share/opencode`. Persist conversations
without it and every restored chat's next follow-up question hits opencode with
a dangling `--session`. The chart mounts it as a `subPath` off the same PVC.

## Jenkinsfile builder

The Jenkinsfile module is a visual builder for the internal
`jenkins-k8s-shared-library` Groovy library: stages are drag-reorderable cards,
each stage exposes every argument its library step accepts, and the generated
Groovy is previewed live and copied or downloaded. It runs no jobs and talks to
no external system — the only server-side state is saved pipeline documents.

- **The `@Library` import is optional and half fixed.** The library *name* is a
  deployment fact (`JENKINS_SHARED_LIBRARY`, served alongside the pipeline list
  rather than on the public `/api/config`), so the builder only asks for a branch
  to pin — typing the name into every pipeline only creates the chance to typo
  it. Off is the resting state: a dotted button in the shape of the box it opens
  into. An empty `library` emits no import line at all.
- **The library's surface is transcribed by hand** into
  `client/modules/jenkinsfile/catalog.ts`, one `StepSpec` per `vars/*.groovy`
  file, with `COMMON_ARGS` spread into all of them exactly as the library does
  `sonarArgsSpec + genStage.genStageArgsSpec`. **When the library gains or
  renames an argument, update that file** — nothing reads the library repo at
  runtime. That is deliberate: no clone step, no Groovy parser, and no way for a
  network failure to leave the builder empty.
- `pipeline.ts` re-implements the checks `Args/ArgsValidator` makes (title
  required, exactly one of `image`/`node`, required keys on
  `secrets`/`additionalRepos`/`customPVC`), so a mistake shows up while you type
  rather than three minutes into a build. `groovy.ts` is the generator and is
  pure — both are covered by unit tests, which is where the output format is
  pinned.
- The output is **scripted, not declarative**: every step in the library opens
  its own `stage()` through `podLauncher`/`nodeExecutor`, so they are called one
  after another at the top level, never inside a `pipeline {}` block.
- **The list you reorder is the list you edit.** `StageList.tsx` is one column of
  `StageCard.tsx`s: the header is the card collapsed (grip, position, title,
  description, ▲/▼, ×) and expanding it drops the whole argument editor in
  underneath. There is no rail-and-panel split to keep in sync, so the order on
  screen is the order in the file. **Whether a card is minimized is saved with
  the pipeline** (`JenkinsfileStage.collapsed`), so one opens the way it was
  left; the header carries an explicit Minimize/Edit button beside the chevron,
  because folding a card away needs a visible way back.
- **`populateEnvVars` is a card like any other**, not a pipeline-level preamble —
  it is a top-level call in the generated Groovy exactly as the stages are, so
  where it sits in the list is where it lands in the file. It is the one
  `callStyle: "bare"` step in the catalog (`populateEnvVars([SERVICE: 'x'])`, not
  `populateEnvVars(envVars: [...])`), it takes no title or runtime, and the
  palette hides it once one exists (`SINGLETON_STEPS`). Records written before
  this carry the map at the top level instead; `toDraft` migrates one into a
  leading card on open and `toInput` writes `envVars: {}` back, so the migration
  runs once. Per-stage `envVars` still covers the in-stage case, and is what the
  library recommends for parallel builds since `populateEnvVars` writes to the
  global env.
- **Pipeline parameters** are emitted as a `properties([parameters([...])])`
  block ahead of the stages. All five Jenkins types are offered — boolean,
  string, text, choice, password — described in `params.ts`, which carries the
  emitted function name as data because `booleanParam` is the one that is not
  named after its type. Every type stores its default as a **string** (`"true"` /
  `"false"` for a boolean) so switching a parameter's type keeps what was already
  typed; `choice` has no default field at all, since Jenkins takes the first
  choice. Records written when every parameter was a `booleanParam` with a real
  boolean default are normalised by `toDraft`.
- Parameters exist mainly to make a stage's skip condition a build-time choice:
  declare `skipImage`, then set a stage's `skipStage` to `params.skipImage`.
  `skipStage` is therefore an `expression` argument — a raw Groovy string emitted
  **unquoted** — not a checkbox. The library's `genStage` does a bare
  `if (args.skipStage)` and its validator coerces with `turnToBoolean`, so any
  truthy expression is legal there. Records written when it was a boolean still
  work: `true` renders as `true`, and `false` means "not set" and drops out.
- **`commands` is one argument with two shapes**, because the library's
  `executeCommands` branches on exactly that: an `ArrayList` it joins with `&&`
  and hands to `sh`/`bat`, or a `Closure` it calls. The `commands` kind renders a
  Shell/Closure switch over one textarea, and the value is boxed so the two are
  never confused — an array is shell, `{ closure }` is Groovy written through
  verbatim. `postCommands` takes the same choice. Flipping the switch keeps the
  text: the same lines usually want to become `sh '…'` calls. On the two gen
  stages `commands` is `required`, so it is pinned open beside title and image
  rather than sitting in the collapsed common group — a gen stage with no
  commands is not a stage. `common(exclude, require)` in the catalog is what
  marks it, per step, because `semVerStage` and `sonarStage` run their own work
  and take none.
- **Problems are held back until you press outside the thing they are about.**
  They are computed from the first keystroke, but a field you are still in the
  middle of is not a mistake yet, so `touched` gates them per stage (plus one
  scope for the parameters). `useLeaveScopes` is one document `pointerdown`
  listener rather than a handler per card — the press that reveals a stage's
  problems usually lands on a *different* stage or on the page background,
  neither of which the card can see. Elements opt in with `data-touch-scope`;
  each card also has its own `onBlur`, but only for a *non-null* `relatedTarget`
  — a null one means a press on something unfocusable, which may well be inside
  that same card, and moving between a stage's own fields must not turn it red.
  Opening or starting a pipeline resets the gate.
- **Every argument a step takes is on screen, always**, in catalog order: the
  ones in use as fields, the rest as one-line rows you click to add, so adding
  one expands it in place rather than reshuffling the list. The three the library
  validates for (`title`, and exactly one of `image`/`node`) are pinned open
  above the rest and cannot be removed — `image`/`node` as a two-way segmented
  control, since they are one choice and not two fields. **What is pinned is a
  per-step question**, because every wrapper in the library assigns its own
  (`args.title = args.title ?: 'Sonar Scanning'`) before validating: only the two
  gen stages leave `title`, the runtime and `commands` open, and `common(exclude,
  require)` marks them. `pinsRuntime(spec)` is the same rule for the image/node
  control — a step with a default image has nothing to choose. Everywhere else
  they are ordinary optional arguments in the add list, and validation follows
  the same `required` flag rather than a second hardcoded rule. A step's own
  default is the field's placeholder, so leaving it blank visibly means "use
  `sonar`". The step's-own/from-genStage split into two groups only applies to
  steps that actually wrap `genStage`.
- **A list of maps is a list of boxes.** `secrets`, `additionalRepos` and
  `customPVC` render one bordered entry per element, each field labelled, with a
  one-line hint and the longer story behind a `?` — three bare inputs reading
  `secret/team/service`, `token`, `SERVICE_TOKEN` say nothing about which is
  which. `ObjectField` carries `hint` and `description` for that. The `?` is a
  button, not a `title=` tooltip: a tooltip cannot be opened by touch and
  vanishes while you read it.
- **Removing the last entry removes the argument.** Both `MapRows` and
  `ObjectRows` render one placeholder row when the value is empty, so without
  this the `×` on a single row appeared to do nothing — `onChange([])` just
  re-rendered the same blank row.
- **`unstash` picks, it does not type.** It offers the stash names declared by
  *earlier* stages (`stashesBefore` in `StageList`) — the library stashes after
  a stage's commands run, so a stage cannot unstash its own. A name held over
  from a since-deleted stage stays on the list, marked, so it can be unticked
  rather than silently vanishing.
- **Textareas grow a row per line and are not user-resizable** — a dragged height
  only fights the auto-size on the next keystroke. The value of a list field is
  the raw split of the text, blank lines included: filtering them on the way in
  is what used to make Enter look broken, because the empty line you just made
  was dropped before it could render. The generator drops blanks instead.
- **A list pasted out of an existing Jenkinsfile is unwrapped.** `"npm install",`
  on its own line becomes `'npm install'`, not `'"npm install",'`. `unwrap` in
  `groovy.ts` only strips a quote pair that wraps the whole line with none of
  that quote inside it, so `echo "hi"` and `"$A" = "$B"` survive untouched.
- **Drag and drop is native HTML5**, no library — three handlers over an array
  in `StageList.tsx`, and it is the only way to reorder. A card is draggable only
  while collapsed: a text input inside an expanded card cannot be selected with
  the mouse if its ancestor is grabbing the drag.
- **Adding a stage is the last thing in the list**, and its palette is a popover
  rather than a panel in the flow — one that reflowed the page on open would move
  the button out from under the cursor that just pressed it. It is centred with
  auto margins, not `translateX(-50%)`: the shared `row-in` animation animates
  `transform` and would win.
- Maps are edited as ordered key/value **pairs**, not as objects — an object
  cannot hold the half-typed state of renaming a key. They become objects again
  at the edges (`recordOf` on the way to the server; the generator reads either
  shape). A map whose keys the library fixes (`resources`) is the exception: it
  renders as one labelled box per allowed key, so the key cannot be misspelled
  into a `resourcesValidator` failure.
- Pipelines live one JSON file per pipeline under `<DATA_DIR>/jenkinsfile`,
  ids `JF-0001`, via `PipelineStore` — the AI module's conversation store in
  miniature, not `JobStore` (which is `status`/`log`-shaped and splits in-flight
  from settled). **These are user documents, so `DELETE` really deletes.** The
  "nothing is ever deleted" rule above is about run history.
- **There is no name field and no Save button.** The server names a pipeline
  `<author> #<n>` on create (`mintName` in `router.ts`), where `n` is the lowest
  free number among that author's own pipelines — so two people never collide,
  and deleting #2 lets the next one reuse it. `name` is not in the request body
  at all, which is also why an admin editing someone else's pipeline cannot
  rename it out from under them.
- **Saving is automatic**, debounced ~800ms after the last change, with the state
  shown in the topbar. Two refs make it safe: `persisted` holds the JSON of what
  the server last returned, so an edit that lands back in the same shape is not
  written again and the response cannot loop; `queue` chains the writes, so the
  create that mints the id finishes before the first PUT needs it. A draft nobody
  has touched is never written — opening the module must not litter the list with
  empty pipelines. The response is merged field-by-field (`id`, `name`,
  `updatedAt`) rather than wholesale, so typing during a slow request is not
  stamped on.
- The saved list uses the portal's standard `.ticket-row` shape, same as every
  other module. Editing a pipeline is opening it; there is nothing else to do to it.

## Logging

`src/server/log.ts` is the only logger — `log.info/warn/error/debug(scope, message, fields?)`,
one line each, `2026-08-19T20:28:23.500Z WARN  [scope] message key=value`. Never
`console.log` in server code: every line here goes through `redactSecrets`, and that
is the single choke point that keeps tokens out of the log.

- **`log.error(scope, msg, err)`** takes the error itself and walks the whole `.cause`
  chain, then prints the stack. Node's `fetch` throws a bare `TypeError: fetch failed`
  and hides `ENOTFOUND`/`ECONNREFUSED`/cert errors one level down, so passing the error
  rather than `err.message` is the difference between a usable log and a useless one.
- **`userMessage(err)`** is the same information phrased for the UI — `fetch failed
  (getaddrinfo ENOTFOUND artifactory.example.com)`. Job failures and the 500 branch of
  the error handler both use it, so what a developer reads on screen names the real cause.
- **Correlation.** `requestLogger` gives every request an id, returns it as
  `X-Request-Id`, and every error body carries it as `requestId`. The client appends
  `(ref <id>)` to the message it throws, so the string on screen greps the pod log
  directly. The browser console prints the same `ref` on every response.
- **Job logs are mirrored to stdout** with the job id (`[artifactory ART-0007]`,
  `[whitening WHT-0003]`, `[ai RES-0012]`) — each module's `appendLog` does it, so
  anything the user sees in the job drawer is also in `kubectl logs`.
- **Client:** `src/client/log.ts` wraps `window.fetch` once, so every request is logged
  with timing, status and `ref` without any module's `api.ts` knowing. Verbose output is
  on in dev, and in prod per browser via `localStorage.portalDebug = "1"`. Errors ignore
  that gate and always print — a user reporting a problem shouldn't have to reproduce it
  twice.

## Branching

Create a new branch when starting work on a distinct feature, fix, or refactor — especially before making changes that are non-trivial or unrelated to whatever branch is currently checked out.

```bash
git checkout -b feature/<short-description>   # new feature or module
git checkout -b fix/<short-description>       # bug fix
```

Use the existing branch only if the work is a direct continuation of what that branch already contains.

This is enforced, not just advised: the global Stop hook
(`~/.claude/hooks/auto-commit-push.sh`, registered in `~/.claude/settings.json`
so it covers every repo on this machine) refuses to commit onto
`main`/`master`/`dev`/`develop`/`trunk`. When a turn ends with changes on one of
those, it creates a branch named after the generated commit subject
(`feat(auth): add login retry` → `feat/add-login-retry`) and commits there.
Follow-up turns are already off the protected branch, so they stay put — one
branch per task, not per turn. Merging back to `dev`/`main` is a deliberate act,
which is also what cuts the release.

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
diff to opencode's free zen models to name the change, and falls back to
`chore: checkpoint <ts>` if that fails or returns anything that isn't a valid
subject line.

**No API key is involved.** `https://opencode.ai/zen/v1/chat/completions` is
OpenAI-compatible and serves the `*-free` models unauthenticated, so this costs
nothing per turn and there is no credential to configure or rotate. It replaced
a Haiku call over the Anthropic Messages API, which needed `ANTHROPIC_API_KEY`
set per machine and was in practice never set — which is why the history before
this is wall-to-wall `chore: checkpoint`.

Details of the model choice (which free models are unusable, and why it is the
completions endpoint rather than `opencode run`) are in the hook itself and in
the global `~/.claude/CLAUDE.md`.

## Pushing

After committing, push the branch to origin so work is backed up and reviewable. The Stop hook does this automatically after every turn — but only when `origin` is under `shugi12345` or `devops-ezrahi`, so third-party clones get local checkpoints and no push. The manual commands below are for pushing by hand.

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

ArgoCD watches homelab `main` with `automated: {selfHeal: true}`, so step 4 is
the deploy. Commit to pod is roughly four to five minutes, and CI is most of it
— steps 1-3 take ~3 minutes, ArgoCD ~90s to notice plus the rollout.

That ~90s used to be six minutes. ArgoCD polls (a webhook is impossible — the
lab's domain resolves to a LAN IP GitHub cannot reach), and the wait is **two**
timers that stack: `timeout.reconciliation` *and* repo-server's
`--revision-cache-expiration`, which caches the branch → commit-SHA lookup for
3m by default and hands a fast reconcile a stale SHA. Both are 30s in
`../homelab/helm-values/argocd.yaml.tmpl`. If a deploy ever seems stuck, check
that before suspecting CI:

```bash
kubectl -n argocd get application devops-portal \
  -o jsonpath='{.status.sync.revision} {.status.reconciledAt}{"\n"}'
kubectl -n argocd annotate application devops-portal \
  argocd.argoproj.io/refresh=hard --overwrite   # skip the wait
```

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
