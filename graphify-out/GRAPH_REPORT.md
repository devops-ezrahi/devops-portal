# Graph Report - .  (2026-07-19)

## Corpus Check
- Large corpus: 69 files · ~1,584,840 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 447 nodes · 908 edges · 23 communities (15 shown, 8 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 17 edges (avg confidence: 0.71)
- Token cost: 0 input · 131,449 output

## Community Hubs (Navigation)
- Ticketing In-Memory Backend
- Server App & Auth Core
- Client Shell & Access Control
- Server Runtime Dependencies
- Project Conventions & Deploy Rationale
- Test & Dev Tooling Dependencies
- Artifactory Module (Client)
- Ticketing Module (Admin Client)
- TypeScript & Build Config
- Artifactory Module (Server)
- Playwright Screenshot Driver
- Build Export Bundle Artifact
- Auto Commit-Push Script
- LDAP Group Parsing
- Build Bundle Script
- Container Entrypoint Script
- Env Validation
- Prod Server Entry
- Dev Server Entry
- Shared Cross-Module Types

## God Nodes (most connected - your core abstractions)
1. `PortalUser` - 27 edges
2. `JiraTicketingApi` - 23 edges
3. `TicketDetail` - 20 edges
4. `request()` - 18 edges
5. `createTicketingRouter()` - 18 edges
6. `compilerOptions` - 17 edges
7. `InMemoryTicketingApi` - 16 edges
8. `TicketSummary` - 16 edges
9. `RealArtifactoryApi` - 15 edges
10. `TicketingApi` - 15 edges

## Surprising Connections (you probably didn't know these)
- `app.ts — Express app, mounts all module routers` --references--> `createArtifactoryRouter()`  [EXTRACTED]
  CLAUDE.md → src/server/modules/artifactory/router.ts
- `driver.mjs Playwright driver` --references--> `InMemoryTicketingApi`  [EXTRACTED]
  .claude/skills/run-devops-portal/SKILL.md → src/server/modules/ticketing/InMemoryTicketingApi.ts
- `Module pattern — mirrored server/client folders per feature` --references--> `createTicketingRouter()`  [EXTRACTED]
  CLAUDE.md → src/server/modules/ticketing/router.ts
- `app.ts — Express app, mounts all module routers` --references--> `createRagflowRouter()`  [EXTRACTED]
  CLAUDE.md → src/server/modules/ragflow/router.ts
- `app.ts — Express app, mounts all module routers` --references--> `createTicketingRouter()`  [EXTRACTED]
  CLAUDE.md → src/server/modules/ticketing/router.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **CI/CD pipeline sequential steps (vars, build, push, chart bump)** — gitea_workflows_deploy_vars, gitea_workflows_deploy_build, gitea_workflows_deploy_push, gitea_workflows_deploy_bump_chart_tag [EXTRACTED 1.00]
- **Swappable backend implementations via dependency injection** — src_server_modules_ticketing_jiraticketingapi_jiraticketingapi, src_server_modules_ticketing_inmemoryticketingapi_inmemoryticketingapi, src_server_modules_artifactory_realartifactoryapi_realartifactoryapi, claude_dependency_injection_policy [INFERRED 0.85]
- **SSO auth flow: oauth2-proxy, Keycloak rationale, forwarded headers, parseGroups** — claude_oauth2_proxy_bundling, claude_parsegroups_cn_handling, src_server_auth_ts_parsegroups, claude_openshift_keycloak_rationale [INFERRED 0.85]

## Communities (23 total, 8 thin omitted)

### Community 0 - "Ticketing In-Memory Backend"
Cohesion: 0.07
Nodes (35): stages, getRequestType(), validateRequestFields(), InMemoryTicketingApi, nowIso(), summarize(), JiraComment, JiraIssue (+27 more)

### Community 1 - "Server App & Auth Core"
Cohesion: 0.05
Nodes (44): Startup config read from env once into a frozen config object, createApp(), authed(), ticketingApp(), app.ts — Express app, mounts all module routers, Express, isAdmin(), knownUsers (+36 more)

### Community 2 - "Client Shell & Access Control"
Cohesion: 0.07
Nodes (29): AccessDeniedScreen(), ForbiddenError, getMe(), getPortalConfig(), PortalConfig, setDevRole(), UnauthenticatedError, App() (+21 more)

### Community 3 - "Server Runtime Dependencies"
Cohesion: 0.05
Nodes (37): cors, dotenv, express, highlight.js, lucide-react, multer, dependencies, cors (+29 more)

### Community 4 - "Project Conventions & Deploy Rationale"
Cohesion: 0.07
Nodes (37): Branching convention (feature/, fix/), Commit message convention (imperative, <=72 chars, why not what), demoUsers/role switcher + dev fallback user — intentional temporary exception for local dev without SSO, Inject a data API into a router only when more than one implementation exists, Gitea Actions -> in-cluster registry -> ArgoCD deployment pipeline, DevOps Customer Portal project, Dockerfile builds the production image from dist/, Module pattern — mirrored server/client folders per feature (+29 more)

### Community 5 - "Test & Dev Tooling Dependencies"
Cohesion: 0.05
Nodes (37): concurrently, jsdom, devDependencies, concurrently, jsdom, react, react-dom, supertest (+29 more)

### Community 6 - "Artifactory Module (Client)"
Cohesion: 0.09
Nodes (27): requestFormData(), FileEntry, getJob(), listJobs(), submitFolderUpload(), submitUrlCopy(), ArtifactoryView(), Tab (+19 more)

### Community 7 - "Ticketing Module (Admin Client)"
Cohesion: 0.19
Nodes (27): request(), AdminTicketingView(), TicketRow(), addAdminComment(), addComment(), createTicket(), getAdminTicket(), getAssignees() (+19 more)

### Community 8 - "TypeScript & Build Config"
Cohesion: 0.07
Nodes (27): DOM, DOM.Iterable, ES2022, node, src, @testing-library/jest-dom, vite.config.ts, vitest.config.ts (+19 more)

### Community 9 - "Artifactory Module (Server)"
Cohesion: 0.18
Nodes (10): execFileAsync, nowIso(), RealArtifactoryApi, createArtifactoryRouter(), upload, urlCopySchema, ArtifactoryApi, ArtifactoryJob (+2 more)

### Community 10 - "Playwright Screenshot Driver"
Cohesion: 0.50
Nodes (4): { chromium }, require, run(), ss()

### Community 11 - "Build Export Bundle Artifact"
Cohesion: 0.67
Nodes (3): export-build-bundle skill (produces build-export.tar.gz), Binary archive data misrendered/misnamed as PNG, build-export.tar.gz.png (noise/static image)

## Ambiguous Edges - Review These
- `build-export.tar.gz.png (noise/static image)` → `Binary archive data misrendered/misnamed as PNG`  [AMBIGUOUS]
  build-export.tar.gz.png · relation: conceptually_related_to

## Knowledge Gaps
- **128 isolated node(s):** `auto-commit-push.sh script`, `build-bundle.sh script`, `require`, `{ chromium }`, `name` (+123 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `build-export.tar.gz.png (noise/static image)` and `Binary archive data misrendered/misnamed as PNG`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `createTicketingRouter()` connect `Server App & Auth Core` to `Ticketing In-Memory Backend`, `Project Conventions & Deploy Rationale`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Why does `Module pattern — mirrored server/client folders per feature` connect `Project Conventions & Deploy Rationale` to `Server App & Auth Core`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **Why does `DevOps Customer Portal project` connect `Project Conventions & Deploy Rationale` to `Server App & Auth Core`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `JiraTicketingApi` (e.g. with `RealArtifactoryApi` and `InMemoryTicketingApi`) actually correct?**
  _`JiraTicketingApi` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `auto-commit-push.sh script`, `build-bundle.sh script`, `require` to the rest of the system?**
  _128 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Ticketing In-Memory Backend` be split into smaller, more focused modules?**
  _Cohesion score 0.07382091592617908 - nodes in this community are weakly interconnected._