# Graph Report - .  (2026-07-22)

## Corpus Check
- Corpus is ~17,660 words - fits in a single context window. You may not need a graph.

## Summary
- 434 nodes · 902 edges · 17 communities (14 shown, 3 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 13 edges (avg confidence: 0.7)
- Token cost: 80,152 input · 0 output

## Community Hubs (Navigation)
- Ticketing Backend (Server)
- Client App Shell & Modules
- Server App, Auth & Config
- npm Runtime Dependencies
- npm Dev Dependencies
- Ticketing Client UI
- Deployment & Docs
- TypeScript Config
- Artifactory Backend
- Ragflow Chat Client
- Playwright Dev Driver
- Auto-Commit Hook Script
- Build Bundle Script
- Gitea Push Pipeline

## God Nodes (most connected - your core abstractions)
1. `PortalUser` - 27 edges
2. `JiraTicketingApi` - 21 edges
3. `TicketDetail` - 20 edges
4. `request()` - 18 edges
5. `compilerOptions` - 17 edges
6. `TicketSummary` - 16 edges
7. `InMemoryTicketingApi` - 15 edges
8. `TicketingApi` - 15 edges
9. `RealArtifactoryApi` - 14 edges
10. `createTicketingRouter()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Module pattern: mirrored server/client folders, DI only for multi-backend modules` --references--> `App()`  [EXTRACTED]
  CLAUDE.md → src/client/App.tsx
- `Module pattern: mirrored server/client folders, DI only for multi-backend modules` --references--> `RealArtifactoryApi`  [EXTRACTED]
  CLAUDE.md → src/server/modules/artifactory/RealArtifactoryApi.ts
- `Module pattern: mirrored server/client folders, DI only for multi-backend modules` --references--> `InMemoryTicketingApi`  [EXTRACTED]
  CLAUDE.md → src/server/modules/ticketing/InMemoryTicketingApi.ts
- `driver.mjs (Playwright driver)` --references--> `InMemoryTicketingApi`  [EXTRACTED]
  .claude/skills/run-devops-portal/SKILL.md → src/server/modules/ticketing/InMemoryTicketingApi.ts
- `Module pattern: mirrored server/client folders, DI only for multi-backend modules` --references--> `JiraTicketingApi`  [EXTRACTED]
  CLAUDE.md → src/server/modules/ticketing/JiraTicketingApi.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Gitea Actions -> in-cluster registry -> ArgoCD deployment pipeline** — claude_skills_ship_to_homelab_skill_shiptohomelab, gitea_workflows_deploy_buildanddeploy, homelab_chart_values, argocd, claude_sso_deployment [EXTRACTED 1.00]
- **Swappable backend DI pattern (ticketing/artifactory modules)** — claude_module_pattern, src_server_modules_ticketing_jiraticketingapi_jiraticketingapi, src_server_modules_ticketing_inmemoryticketingapi_inmemoryticketingapi, src_server_modules_artifactory_realartifactoryapi_realartifactoryapi [EXTRACTED 1.00]
- **Local dev verification flow (dev server, Playwright driver, seed ticket, finishing-task check)** — claude_skills_run_devops_portal_skill_rundevopsportal, claude_skills_run_devops_portal_skill_drivermjs, src_server_modules_ticketing_inmemoryticketingapi_inmemoryticketingapi, claude_finishing_a_task [INFERRED 0.85]

## Communities (17 total, 3 thin omitted)

### Community 0 - "Ticketing Backend (Server)"
Cohesion: 0.08
Nodes (29): getRequestType(), validateRequestFields(), InMemoryTicketingApi, nowIso(), summarize(), JiraComment, JiraIssue, JiraSearchResponse (+21 more)

### Community 1 - "Client App Shell & Modules"
Cohesion: 0.05
Nodes (48): index.html entry document, AccessDeniedScreen(), ForbiddenError, getMe(), PortalConfig, request(), requestFormData(), setDevRole() (+40 more)

### Community 2 - "Server App, Auth & Config"
Cohesion: 0.06
Nodes (43): Config & environment: single process.env read via config.ts, Pipe-separated groups / CN= DN extraction rationale, createApp(), authed(), ticketingApp(), Express, isAdmin(), knownUsers (+35 more)

### Community 3 - "npm Runtime Dependencies"
Cohesion: 0.05
Nodes (37): cors, dotenv, express, highlight.js, lucide-react, multer, dependencies, cors (+29 more)

### Community 4 - "npm Dev Dependencies"
Cohesion: 0.05
Nodes (37): concurrently, jsdom, devDependencies, concurrently, jsdom, react, react-dom, supertest (+29 more)

### Community 5 - "Ticketing Client UI"
Cohesion: 0.17
Nodes (27): AdminTicketingView(), TicketRow(), addAdminComment(), createTicket(), getAdminTicket(), getAssignees(), getRequestTypes(), getTicket() (+19 more)

### Community 6 - "Deployment & Docs"
Cohesion: 0.08
Nodes (32): ArgoCD, build-export.tar.gz.png intentional naming note, DevOps Customer Portal CLAUDE.md, Finishing a task checklist, Module pattern: mirrored server/client folders, DI only for multi-backend modules, No mock data in production code policy, Removed OpenShift-native OAuth path (os4-chart, origin-oauth-proxy, AUTH_PROVIDER), build-export.tar.gz bundle output (+24 more)

### Community 7 - "TypeScript Config"
Cohesion: 0.07
Nodes (27): DOM, DOM.Iterable, ES2022, node, src, @testing-library/jest-dom, vite.config.ts, vitest.config.ts (+19 more)

### Community 8 - "Artifactory Backend"
Cohesion: 0.17
Nodes (10): execFileAsync, nowIso(), RealArtifactoryApi, createArtifactoryRouter(), upload, urlCopySchema, ArtifactoryApi, ArtifactoryJob (+2 more)

### Community 9 - "Ragflow Chat Client"
Cohesion: 0.15
Nodes (15): getPortalConfig(), streamChat(), ChatView(), createSession(), loadActiveId(), loadSessions(), makeId(), MessageList() (+7 more)

### Community 10 - "Playwright Dev Driver"
Cohesion: 0.50
Nodes (4): { chromium }, require, run(), ss()

## Knowledge Gaps
- **121 isolated node(s):** `auto-commit-push.sh script`, `build-bundle.sh script`, `require`, `{ chromium }`, `name` (+116 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `DevOps Customer Portal CLAUDE.md` connect `Deployment & Docs` to `Server App, Auth & Config`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Why does `Module pattern: mirrored server/client folders, DI only for multi-backend modules` connect `Deployment & Docs` to `Artifactory Backend`, `Client App Shell & Modules`, `Ticketing Backend (Server)`?**
  _High betweenness centrality (0.064) - this node is a cross-community bridge._
- **Why does `PortalUser` connect `Ticketing Backend (Server)` to `Client App Shell & Modules`, `Server App, Auth & Config`, `Ticketing Client UI`, `Artifactory Backend`, `Ragflow Chat Client`?**
  _High betweenness centrality (0.047) - this node is a cross-community bridge._
- **What connects `auto-commit-push.sh script`, `build-bundle.sh script`, `require` to the rest of the system?**
  _121 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Ticketing Backend (Server)` be split into smaller, more focused modules?**
  _Cohesion score 0.08013640238704177 - nodes in this community are weakly interconnected._
- **Should `Client App Shell & Modules` be split into smaller, more focused modules?**
  _Cohesion score 0.05311676909569798 - nodes in this community are weakly interconnected._
- **Should `Server App, Auth & Config` be split into smaller, more focused modules?**
  _Cohesion score 0.055811571940604196 - nodes in this community are weakly interconnected._