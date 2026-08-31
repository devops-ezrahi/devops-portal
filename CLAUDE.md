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
- `modules/jenkinsfile/devSimulation.ts` — a scripted image list for the
  builder's `image` picker. There is no Artifactory behind `npm run dev`, so
  without it the field suggests nothing and the picker cannot be seen at all
  offline. `pickableImages` reaches for it only when `SSO_REQUIRED` is not
  `true` **and** no real `JENKINS_IMAGES_PATH`/Artifactory is configured — a
  real lookup always wins, and a deployment never serves it.
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
| `ARTIFACTORY_MAVEN_REPO` / `_RPM_REPO` / `_PYPI_REPO` / `_CONDA_REPO` / `_HELM_REPO` | —       | Per-type repos the Artifactory module routes detected artifacts to (`packageTypes.ts`); unset = that type is skipped with a log line. Helm is the one that is not routed by filename: a chart is a `.tgz` exactly like an npm package, so `readTarballIdentity` decides from the manifest inside (`<chart>/Chart.yaml` vs `package/package.json`). |
| `NPM_SOURCE_TOKEN`                                            | —               | Credential for the *source* npm registry when a URL copy is submitted with **Include dependencies** ticked. That path derives the registry from the pasted tarball URL (`<registry>/<name>/-/<file>.tgz`), writes it plus this token into a throwaway `.npmrc`, and runs a real `npm install` — once per target platform, since optional deps are platform-gated. Unset is normal: a public registry needs nothing, and a source registry on the same host as `ARTIFACTORY_URL` reuses `ARTIFACTORY_TOKEN` automatically. |
| `GIT_URL` / `GIT_TOKEN`                                      | —               | Bitbucket Server base URL + HTTP access token; required for the Whitening module to open pull requests. The AI module reuses the same token to authenticate `git clone` for registered `ai-*` project repos (unset = clone stays unauthenticated, so public repos still work) |
| `GIT_USERNAME`                                               | —               | Empty (default) puts the token alone in the clone URL; set it only if Bitbucket wants `username:token` basic auth           |
| `JENKINS_IMAGES_PATH`                                        | —               | Artifactory storage path whose child folders name the agent images the Jenkinsfile builder's `image` field suggests (e.g. `docker-local/jenkins-agents`). One AQL search per hour per pod returns the names *and* each image's `SCREAMING_CASE` Docker labels (`JDK=17`), which are shown beside the name. Unset, or unreachable, = the field is plain free text exactly as before. |
| `JIRA_URL` / `JIRA_TOKEN` / `JIRA_PROJECT_KEY`               | —               | All three required to activate `JiraTicketingApi` (Jira Data Center, Bearer PAT); otherwise `InMemoryTicketingApi` fallback |
| `JIRA_STORY_POINTS_FIELD`                                    | —               | Custom-field id holding story points (e.g. `customfield_10016`) — instance-specific; unset = points stay portal-only and are not synced to Jira |
| `JIRA_MAINTENANCE_ISSUE_TYPE`                                | `Maintenance`   | The Jira issue type the portal **creates** tickets as, and the one `listAdminTickets` filters the admin queue on — deliberately one var, since creating anything else files tickets the queue then cannot see. It is a Jira fact: the request catalog's display name ("CI/CD Pipeline") is not an issue type any instance has, and Jira answers an unresolvable one with *both* `Could not find issuetype` and a red-herring `project is required`. |
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

The same filename means something else on the **other** side of the wire — see
**Whitening: preserving target-repo files** below. This repo's own copy stays
packer-only; the app never reads the one at this root.

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

## Artifactory: how a folder upload travels

A dropped folder is zipped in the tab and **sent in 8 MB parts while it is still
being zipped** — the two used to run one after the other, so the wait was the
sum of them and the whole archive had to exist in the browser before a byte
moved. `POST /api/artifactory/uploads` mints an `art-<uuid>` temp dir, each
`PUT /api/artifactory/uploads/:id?offset=` appends one part, and
`POST /api/artifactory/jobs/folder-upload` hands the finished file to the job
exactly as the old single multipart POST did — the job pipeline never learned
about any of this.

- **The id is the directory name**, so nothing is held in memory between
  requests and an abandoned upload is swept by the existing 24h `art-` sweep.
  It is a UUID because holding it is what grants the right to append, and it is
  matched against `UPLOAD_ID` *before* it is joined into a path.
- **A part that is not next in line is refused**, not written: the offset the
  client claims must equal the file's current size, or the part would splice
  itself into the middle of the archive and surface minutes later as a corrupt
  zip. That is also why only one part is ever in flight.
- **The 500 MB cap is enforced by a stream in the pipeline** (`byteLimit`), not
  a `data` listener on the request — destroying the request from a listener
  still lets `pipeline` resolve, and the oversized part was then answered
  "200 OK" and kept. The client checks the same number before sending, because
  the server's only way to stop a part is to cut the connection, which reaches
  the user as a dead socket rather than a sentence.
- A single `fetch` with a `ReadableStream` body would say all this in one call
  and is what this would be on a Chrome-only intranet: it needs HTTP/2, which
  `npm run dev` does not serve, and Firefox does not implement it at all.

## Artifactory: where each package type is stored

Every type has one layout its own Artifactory indexer looks in, and putting a
file anywhere else silently produces a repo nothing can install from.
`packageTypes.ts` is the routing table; `storageMatrix.test.ts` pins the exact
target path for every type through **both** entry points, which is the test to
change if any of this moves.

| Type | Target | Why that shape |
| ---- | ------ | -------------- |
| npm | `<npmRepo>/<name>/-/<basename>-<version>.tgz` | The registry layout. The scope stays in the *directory* and is dropped from the filename (`@babel/core/-/core-7.0.0.tgz`) — the same form the public registry and `jfrog-cli` use. (`npm publish` against Artifactory writes the scope twice, `@scope/name/-/@scope/name-1.0.0.tgz`; both resolve, so this is not worth matching.) |
| maven | `<mavenRepo>/<group as dirs>/<artifactId>/<version>/<file>` | The layout **is** the address. Artifactory answers a pom deployed off its own coordinates with a **409**, since POM consistency checks are on by default. |
| pypi | `<pypiRepo>/<file>`, flat | The indexer reads the wheel's or sdist's own metadata, so the path carries nothing. Flat also stays clear of `packages/**` and `simple/**`, which Artifactory reserves. |
| rpm | `<rpmRepo>/<file>`, flat | YUM metadata depth defaults to 0, i.e. `repodata` at the repo root, which is what a flat layout indexes. |
| conda | `<condaRepo>/<subdir>/<file>` | The channel subdir is part of the address; see the `ponytail:` note in `packageTypes.ts`. |
| helm | `<helmRepo>/<name>-<version>.tgz`, flat | Artifactory builds `index.yaml` from each chart's own `Chart.yaml`, so the path carries nothing — the same reason RPM and PyPI are flat. |

**A `.tgz` is identified by what is inside it, never by its name.**
`classify` deliberately does not touch `.tgz`: the filename gives neither the
npm scope (`@babel/core` ships as `core-7.0.0.tgz`) nor whether the tarball is
an npm package at all — a Helm chart is the same gzipped tar with the same
extension. `readTarballIdentity` looks for `package/package.json` first (an
exact path) and then `<chart>/Chart.yaml` (a wildcard, `--no-wildcards-match-slash`
so a bundled subchart's manifest cannot win). When *neither* can be read, the
URL copy falls back to `npmIdentityFromUrl` — a registry-layout URL carries the
scope in its directory, and without that fallback
`.../%40octokit/types/-/types-16.0.0.tgz` fell through to "unrecognised
artifact" and was uploaded flat as `types-16.0.0.tgz`. That fallback path also
now fails loudly when `ARTIFACTORY_REPO` (the unrecognised-file repo, which is
genuinely optional) is unset, instead of PUTting to a path with no repo in it —
which Artifactory answers with a 404 reading "User authentication has failed due
to Repo key cannot be empty", sending the reader after a token problem that does
not exist.

**A pasted URL may be an Artifactory *page*, not a download.** `downloadUrl` in
`packageTypes.ts` rewrites the tree browser (`/ui/repos/tree/General/<repo>/<path>`
— exactly what this app's own `webUrl` hands out) and the package view
(`/ui/native/<repo>/<path>`) to `/artifactory/<repo>/<path>`; anything else is
returned untouched. It runs in `submitUrlCopy`, not in the router's schema, so
the job records the URL everything downstream actually used.

**A groupId cannot be read off a path, so the pom is the authority.**
`org/foo/bar/1.0/bar-1.0.jar` is a valid layout under any number of roots, and
folding the wrong ones in produces `maven-local/pub/java/org/foo/...` — a path
nothing resolves from, and a 409 for the pom. Both entry points now take the
answer from the file rather than guessing at it:

- **URL copy** fetches the sibling pom (`mavenPomUrl` — named from the layout,
  `<artifactId>-<version>.pom`, so `bar-1.0-sources.jar` still asks for
  `bar-1.0.pom`) and, if its coordinates disagree with the URL, **corrects the
  jar's target too**: both files must land under the same group or neither
  resolves. A 404 is normal and quiet — the copy still completes, from the
  path-derived target as before. Checksum sidecars are not fetched; Artifactory
  computes its own on PUT.
- **Folder upload** learns the same correction once per drop
  (`mavenTreePrefix`): the first pom whose coordinates line up with where it
  sits says how many folders the tree is nested under, and that prefix comes off
  every path. So `deps/.m2/repository/org/foo/...` uploads as `org/foo/...`,
  and a drop with no pom in it behaves exactly as before.

**A flat folder of jars is the common case, not the exotic one** — it is what
`mvn dependency:copy-dependencies` writes — and no filename can give a groupId.
`mavenCoordsFromJar` reads `META-INF/maven/<g>/<a>/pom.properties` out of the jar
instead, which is the same trick the npm path already plays with
`package/package.json` inside a `.tgz`. A jar without one falls through to
"unrelated file" as before. The embedded `pom.xml` beside it is deliberately
**not** uploaded: a pom whose `<parent>` is missing from the repo fails
resolution outright, which is worse than the "Missing POM" warning a bare jar
produces.

**Dependency resolution runs the ecosystem's real client — it does not walk the
graph itself.** npm, Maven and PyPI each resolve; RPM and conda do not.
`npmDependencies.ts` shells out to `npm install`, `toolDependencies.ts` to `mvn
dependency:copy-dependencies` and `pip download`, and each writes a directory in
a layout `classify` already routes, so there is no target-path logic in the
resolvers at all: run the tool, walk the output, `classify` each file. That is
the whole reason this is cheap.

Hand-rolling the walk was considered and rejected. A pom's `<dependencies>` is
not the answer — it needs parent chasing, `<dependencyManagement>`,
`${property}` interpolation, BOM `<scope>import</scope>`, ranges, exclusions and
nearest-wins; a wheel's `Requires-Dist` needs PEP 508 markers and version
backtracking against the index. Both land at roughly 85% correct, and a
half-resolved tree is a broken offline install that gives no sign it is broken.

- **The source repository is derived from the pasted URL**, never guessed and
  never configured. `mavenRepoFromUrl` strips `mavenLayoutPath`'s output off the
  end of the URL (the layout *is* the address, so this is exact, not a
  heuristic); `pypiIndexFromUrl` puts the index beside the `packages/` segment,
  which covers PyPI, Artifactory and Nexus. `null` from either is a log line and
  a single-artifact copy, same as `npmRegistryFromUrl`. Credentials come from
  `sourceTokenFor` — a source on the same host as `ARTIFACTORY_URL` reuses
  `ARTIFACTORY_TOKEN`, anything else is anonymous. No new env vars.
- **Maven needs the pom**, so resolution only runs when `fetchMavenPom` found
  one, keyed on the pom's coordinates rather than the URL's.
  `-DoutputDirectory` is deliberately separate from `-Dmaven.repo.local`: only
  the former is uploaded, so the dependency plugin's own jars never get
  published into the customer's repo. The plugin is pinned by full coordinates,
  because the `dependency:` prefix resolves via a metadata lookup that takes
  whatever is newest — a failure in a closed network. It is baked into
  `/opt/m2` at image build and copied per job, so a job never fetches it through
  the source mirror and two concurrent jobs never share a writable local repo.
- **PyPI is wheels only** (`--only-binary=:all:`). `pip download` runs a
  package's `setup.py` for any sdist it fetches, as the portal's own user — the
  same door the npm path closes with `--ignore-scripts`. A tree containing an
  sdist-only package therefore fails to resolve and copies the single artifact.
  One pass, for this pod's platform tags; npm resolves twice because optional
  deps are platform-gated, and wheels are tagged the same way if a Windows
  consumer ever needs the mirror.
- **RPM has no resolver, on purpose.** `dnf --resolve` resolves against *enabled
  repos*, and in the pod that is only the source repo, so anything needing
  system libs fails. Enable the base OS repos to fix that and one `.rpm` drags
  every system package in behind it, because nothing is "already installed" in a
  container. Both directions are wrong, so the URL form still names `dnf
  download --resolve <pkg>` as a manual step feeding the Upload tab.
- **`maven` and `python3-pip` are optional at runtime.** Each resolver probes
  for its binary and returns `null` when it is absent, which the caller turns
  into "not installed in this image — copying the single artifact". The
  Dockerfile line is revertable, and a dev box with neither still runs the
  module.
- `runTool.ts` is the one streaming-spawn helper all three share — line
  buffering, the 300-line log cap, the 15s heartbeat, and keeping a user's Stop
  an `AbortError` while a timeout becomes a message. Three copies of that is
  three places to swallow a Stop.

**The Upload tab takes files, not just a folder.** A drop is read as a list of
roots: one folder keeps its contents at the archive root (which is what the
Maven layout check reads), while several roots each keep their own name, or two
dropped trees overwrite each other. `Choose files` is the same path through a
picker, since a browser file picker cannot select a directory.

**A `node_modules` holds more package folders than it has packages** — this
repo's own is 884 folders for 799 packages, because npm nests a second copy of
the same version wherever hoisting cannot reach a dependent. Every copy packs to
the same tarball at the same target path, so `uniquePackages` keeps one per
`name@version` and the rest are dropped, out loud ("Ignoring N duplicate copies
…") because the count is otherwise smaller than the number of folders the user
knows they dropped. A nested copy of a *different* version is a different
package and is kept.

**That fold is separate from `discoverPackages`, which returns every
directory**, because the directory list is also what decides which files on disk
belong to a package at all. Deduplicating during the walk left the shadowed
copies' files outside every package, and they were then reported as
unrelated loose files — 114 of them for this repo, against a true 44.

Zipping itself is `fflate`'s **synchronous** `ZipDeflate` at level 1, with
already-compressed extensions (`.tgz`, `.whl`, `.rpm`, `.jar`, …) stored
verbatim. `AsyncZipDeflate` spawns a Worker *per entry*, which for a folder of
thousands of small files costs far more than the deflate it moves off-thread —
3,000 files measured at 47.8s async against 0.41s sync.

## Ticketing: one Jira account, many people

The portal authenticates to Jira with a single service-level PAT (`JIRA_TOKEN`),
so Jira records **every** portal action as that one account. Two places had to
work around it rather than pretend otherwise:

- **Comments.** Jira resolves a comment's author from whoever's credentials made
  the request, so the whole thread came back as one person talking to
  themselves. `stampPortalAuthor` writes `<name> (via DevOps Portal, <id>)` as
  the body's first line and `readPortalAuthor` strips it again on the way in —
  readable in Jira's own UI, and a comment written *in* Jira carries no stamp
  and keeps the author Jira recorded. The client's own `[status] ` prefix still
  leads the body once the stamp is off, so `isStatusMessage` is unaffected.
- **Reporter.** Already handled: `unknownReporters` falls "my tickets" back to
  `reporter = currentUser()` once Jira rejects a portal id it has never heard
  of, which is who it recorded as the reporter of everything the portal filed.

## Whitening: preserving target-repo files

The PR the Whitening module opens is built by **emptying the cloned target repo
and copying the pack's `repository/<repo>/` tree over it**
(`RealWhiteningApi.ts`, `pushSourceAndOpenPr`). There is no per-file decision:
anything the closed-network repo has and the pack does not shows up as a
deletion, purely because `git add -A` sees it gone. That is wrong for files that
legitimately live only on that side — its CI config, a local env file, internal
docs.

- **The target repo opts out with its own `whitening.json`**, at its root, listing
  glob patterns under `preserve`. Not the pack's copy and not
  `repository/config.json`: what survives is the receiving repo's call, so it
  must not depend on what a given pack happened to ship.
- **`preserve` means "don't delete", nothing more.** Only *deletions* are undone
  (`--diff-filter=D`), so a preserved path the pack also ships is committed with
  the packed content as normal. Freezing a path against modification too would
  silently drop genuine updates.
- **Git does the globbing**, via `:(glob)` pathspecs — `*` stops at a directory
  boundary, `**` crosses one. No `minimatch`/`picomatch`: those exist here only
  as dev-only transitives, so importing one breaks the prod image (prod deps
  only), and Node 20 has no usable `path.matchesGlob`. The module already shells
  out to git for everything else.
- The list is read **before** the wipe destroys it, and the restore runs
  **after** `git add -A` but **before** the "no changes vs. default branch"
  check — otherwise a PR whose entire diff was those deletions still opens.
- `whitening.json` itself is always preserved implicitly. Without that, the file
  saying "don't delete these" deletes itself on the first PR and the next one
  finds no list.
- A malformed `whitening.json` **fails the job** rather than being ignored:
  quietly protecting nothing deletes the very files it was written to save. A
  pattern matching nothing is fine and silent.

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
- **The `image` field suggests, it does not constrain.** `ImagePicker.tsx` is a
  combobox — the image name on the left, its labels on the right — and anything
  typed is still accepted, which is why it is not a `<select>`. It opens
  downwards, or upwards when the field sits too near the bottom of the window,
  which a stage low in a long list usually does. It replaced a native
  `<datalist>`, which can neither lay a row out in two columns nor open upwards.
  The names come from Artifactory (`JENKINS_IMAGES_PATH`).
  Artifactory is the source rather than the dockerfiles repo that builds these
  images, or the Confluence page that repo's CI publishes, because it is the
  only one of the three that also lists an image pushed there by hand. One AQL
  search (`api/search/aql`, not `api/storage?list`) gets the names and the
  labels together, since the labels are properties on each manifest and a
  listing carries no properties. Only `SCREAMING_CASE` labels are shown
  (`JDK=17`) — Docker's own conventional labels are lowercase and dotted and
  say nothing to someone picking an image. Cached an hour in `images.ts`; a
  failed lookup is deliberately not cached. The list reaches `ArgField` through
  `ImagesContext`, not a prop, because unlike `stashNames` it is one list for
  the whole builder rather than one per stage.
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
- **A pipeline starts empty or from an existing file.** The topbar's New button
  asks which (`NewPipelineDialog.tsx`); importing takes a paste or a file.
  `parse.ts` is the inverse of `groovy.ts` and nothing more — a string-aware
  scanner over the shapes the library uses (`@Library`, `properties([parameters
  ([…])])`, a flat run of top-level step calls with a named-argument map), not a
  Groovy parser. Named arguments are grouped into one map exactly as Groovy
  collects them, which is what lets one reader serve both a step call and a
  `booleanParam(…)`. **Anything it cannot take is reported, never dropped
  silently** — the dialog holds the import back once to show the list, since a
  stage that vanishes without a word is worse than one re-added by hand. A
  declarative `pipeline { … }` file is named as such rather than importing as
  nothing. The round-trip is what the tests pin: parsing the generator's own
  output must regenerate it byte for byte.
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
- **A parameter no stage reads is marked amber**, not red: the Jenkinsfile it
  generates is valid, the parameter just has no effect — which is otherwise
  silent until someone wonders why ticking the box changed nothing. It is held
  back by the same `touched` gate as a stage's problems, and **each parameter is
  its own scope** — the section as a whole was left long ago on an open
  pipeline, so a section-wide gate marked a just-added parameter the moment its
  name was typed. `paramScope` keys on the **name**, not the position: a
  parameter carries no id, and an index is not one, since removing a parameter
  and adding another puts the new one on an index that was already left. A name
  still being typed is a scope nobody has left, which is the wanted answer, and
  renaming an existing one quietens it until the next press outside, which is
  also right. Opening or importing a pipeline touches every parameter, exactly
  as it touches every stage. `useLeaveScopes` therefore collects **every** scope on
  the pressed element's ancestor chain rather than just the nearest: scopes now
  nest, and pressing into a parameter must not count as leaving the parameters
  section that holds it.
  `usedParamNames` scans `JSON.stringify(stages)` for `params.<name>` (and the
  bracket form) rather than the generated Groovy — a reference can sit in any
  argument shape, an expression, a command line, a closure body or a map value,
  and the generated file also contains the declaration itself, which would match
  every name.
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
- **A list is one box per entry**, the same shape `secrets` and `stash` use — a
  textarea made every entry look like one paragraph whose line breaks happened
  to matter. Enter opens the next box, Backspace in an empty one removes it, and
  a multi-line paste splits across boxes rather than collapsing into one, which
  is what pasting out of an existing Jenkinsfile does. The `commands` closure
  form stays a textarea: that one is a block of Groovy, not a list. Blank entries
  are kept in the value — removing them under the cursor is what used to make
  Enter look broken — and dropped by the generator. Textareas that remain grow a
  row per line and are not user-resizable; a dragged height only fights the
  auto-size on the next keystroke.
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
- **The name is minted, then editable; there is no Save button.** The server
  names a pipeline `<author> #<n>` on create (`mintName` in `router.ts`), where
  `n` is the lowest free number among that author's own pipelines — so two
  people never collide, and deleting #2 lets the next one reuse it. Minting
  still matters because a pipeline is saved the moment it has a stage, long
  before anyone thinks to name it. The name then heads the editor
  panel — the editor column is **one** `.detail-panel`, like every other
  module's content column, with the name as its first `.jf-section` and the
  library/parameters/stages/preview separated by a rule inside the box rather
  than by four outlines. It names what that panel is showing, so it sits inside
  it rather than floating above the column or in the toolbar.
  It is **text with a pencil beside it**, the same shape a
  ticket's title uses (`.detail-title-row` / `.title-edit-input` / `.edit-toggle`
  are reused verbatim), because a box sitting there permanently reads as a
  search field. Enter and Escape both just blur: every keystroke is already in
  the draft and autosave is what writes it, so there is no commit to confirm or
  cancel. A list of `Dev User #7` says nothing about what any of them build. **A blank name keeps the stored one**
  rather than emptying the list row, and the create/update response's `name` is
  taken back into the draft only when nothing has been typed — otherwise a slow
  save would overwrite whatever was typed while it was in flight.
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

## Job lists: scope and links

Both job modules (artifactory, whitening) share these, and the ticket queue
follows the first:

- **An admin opens on their own jobs.** The server sends an admin everything and
  the toggle narrows it client-side, but the default is `showAll = false`: the
  run an admin just started is the one they came to look at, and in a shared
  list it is buried. The button names the list it switches *to*; the heading
  beside it says which one is on screen.
- **The selected job is in the URL** (`/artifactory/ART-0007`), so a job can be
  pasted to someone. `useDeepLink` in `src/client/deepLink.ts` is the whole
  mechanism: the shell's router only ever reads the *first* path segment
  (`moduleFromPath` in App.tsx), so a second one costs it nothing, and the prod
  SPA fallback already serves index.html for any path. Two details matter —
  the push effect is keyed on the selected id **alone**, because modules stay
  mounted when hidden and an effect running every render would have a
  background module shove its own path over the one the nav just pushed; and
  the `popstate` handler ignores a pop whose first segment is another module,
  which would otherwise clear the selection sitting behind the tab you left.

## Shared UI conventions

The five modules are meant to read as one product, so these are portal-wide, not
per-module choices:

- **A job's package table is one row per package, not per file.** A Maven copy
  uploads the jar *and* its pom under the same coordinates, and a `.m2` drop
  adds `.sha1`/`.asc` sidecars and `-sources.jar` classifiers on top; listing
  each separately read as several different packages that happened to share a
  name. `groupPackages` in the Artifactory `JobDetail` folds them by
  `type|name@version`, links the non-sidecar file, and shows the **worst**
  status in the group — a pom that failed while the jar landed is a broken
  copy, and rolling it up as "Uploaded" would hide that.
- **A row's error gets its own line.** `.package-row` is `flex-wrap: wrap` with
  the error at `flex-basis: 100%`. Sharing the line with the name meant a
  200-character Artifactory error won, and since `.package-name` is `flex: 1`
  (basis 0) with `word-break: break-all`, its min-content is *one character* —
  the name came out as a vertical column of letters down the left edge.
- **The topbar is `<h1>` then actions, primary last.** "New" is
  `className="primary"` with `<Plus size={18} />` in every module — Tickets,
  Artifactory ("New Job"), Whitening, AI ("New chat") and Jenkinsfile. Secondary
  actions (Delete, Archive) are `ghost-button` to its left.
- **`.workspace-grid` is two columns** (`minmax(260px, 340px)` list +
  `minmax(0, 1fr)` content). A view with only one thing to show must not use it
  — a lone child lands in the narrow list column. Use `.workspace-single` with a
  `.detail-panel`, as the AI module's unconfigured state does.
- **`.empty-state` is a padded block.** `.module-empty` centres it in its panel
  and sizes it by its content; `.chat-panel .empty-state` is the variant that
  fills the window, and belongs only to the chat.
- **A modal must not be trapped inside `.module-slot`.** That wrapper fades each
  module in, and a fill mode on that animation would keep it affecting opacity
  for good — which makes the slot a permanent stacking context at `z-index:
  auto`, painted below the sticky `.app-header`. Every modal inside a module
  then sits under the header whatever `z-index` it asks for. So the slot's
  animation carries no `forwards`/`both`, for the same reason it carries no
  `transform` (which would make it the containing block for `position: fixed`
  and shrink each backdrop to the panel).
- **A modal has to fit a short window**, not just scroll inside one: `.modal`
  caps at `calc(100vh - 44px)`, so any form inside it is sized for a 13" laptop
  with the browser chrome out — roughly 520px of dialog, which is what
  `.modal .request-form`'s smaller padding and 120px textarea are for.
- **An editable title is text with a pencil**, never a permanent input — a box
  sitting in a heading row reads as a search field. Two placements, by
  container: inside a card the pencil goes to the row's far edge as an
  `.icon-button` (`.detail-title-row`, the ticket detail); on a bare column
  heading it sits against the text and drops the 38px box until hover
  (`.jf-title-row`), where a bordered button that size reads as stuck to the
  name.

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
same image — see `scripts/entrypoint.sh`; the image also carries `git`, `unzip`,
`maven` + a headless JRE and `python3-pip`, the last two for the Artifactory
module's dependency resolvers), deployed onto the `k3d-homelab`
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
