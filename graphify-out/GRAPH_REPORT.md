# Graph Report - .  (2026-07-28)

## Corpus Check
- Corpus is ~20,614 words - fits in a single context window. You may not need a graph.

## Summary
- 520 nodes · 1085 edges · 18 communities (16 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 20 edges (avg confidence: 0.76)
- Token cost: 48,349 input · 9,091 output

## Community Hubs (Navigation)
- Ticketing Backend & Jira API
- Server App, Auth & Config
- Client Shell & Module Registry
- Artifactory Upload UI
- CI/CD Pipeline & Ops Rationale
- Dev & Test Dependencies
- Runtime Deps & npm Scripts
- Whitening Packer & Gitea PRs
- Ticketing Client UI
- TypeScript Compiler Config
- RAGFlow Chat UI
- Playwright Screenshot Driver
- Mock Data Policy Exception
- Auto Commit-Push Hook
- Container Entrypoint Script

## God Nodes (most connected - your core abstractions)
1. `PortalUser` - 31 edges
2. `JiraTicketingApi` - 24 edges
3. `request()` - 21 edges
4. `TicketDetail` - 20 edges
5. `compilerOptions` - 17 edges
6. `TicketSummary` - 16 edges
7. `TicketingApi` - 15 edges
8. `createTicketingRouter()` - 14 edges
9. `RealWhiteningApi` - 14 edges
10. `WhiteningJob` - 14 edges

## Surprising Connections (you probably didn't know these)
- `In-memory ticket state cleared on restart` --semantically_similar_to--> `demoUsers + dev fallback user (temporary exception)`  [INFERRED] [semantically similar]
  .claude/skills/run-devops-portal/SKILL.md → CLAUDE.md
- `GitHub Actions CI workflow` --semantically_similar_to--> `Gitea Actions Build and Deploy workflow`  [INFERRED] [semantically similar]
  .github/workflows/ci.yml → .gitea/workflows/deploy.yaml
- `Gitea Actions to in-cluster registry to ArgoCD deployment path` --conceptually_related_to--> `ship-to-homelab skill`  [INFERRED]
  CLAUDE.md → .claude/skills/ship-to-homelab/SKILL.md
- `Playwright driver.mjs (headless module walkthrough)` --references--> `index.html SPA shell (#root + /src/client/main.tsx)`  [INFERRED]
  .claude/skills/run-devops-portal/SKILL.md → index.html
- `Finishing a task — run every command, verify in the real app` --references--> `Playwright driver.mjs (headless module walkthrough)`  [EXTRACTED]
  CLAUDE.md → .claude/skills/run-devops-portal/SKILL.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Gitea push to running pod pipeline** — _gitea_workflows_deploy_build_step, _gitea_workflows_deploy_push_step, _gitea_workflows_deploy_bump_chart_tag, _claude_skills_ship_to_homelab_skill_argocd_selfheal, _claude_skills_ship_to_homelab_skill_ship_to_homelab, claude_deployment_pipeline [EXTRACTED 1.00]
- **Whitening pack build and handoff flow** — _github_workflows_ci_pack_job, _github_workflows_ci_whitening_packer_repo, _github_workflows_ci_pack_tag_delta_baseline, _github_workflows_ci_release_asset, claude_whitening_json, claude_whitening_module [EXTRACTED 1.00]
- **DinD-in-k3d networking constraints shaping the build** — _gitea_workflows_deploy_buildkit_disabled, _gitea_workflows_deploy_registry_hop, _claude_skills_ship_to_homelab_skill_act_runner_dind, _claude_skills_ship_to_homelab_skill_registry_trust [INFERRED 0.85]

## Communities (18 total, 2 thin omitted)

### Community 0 - "Ticketing Backend & Jira API"
Cohesion: 0.05
Nodes (45): stages, getRequestType(), requestCatalog, validateRequestFields(), InMemoryTicketingApi, nowIso(), summarize(), JiraComment (+37 more)

### Community 1 - "Server App, Auth & Config"
Cohesion: 0.05
Nodes (45): createApp(), authed(), ticketingApp(), Express, isAdmin(), knownUsers, listAdminCandidates(), parseGroups() (+37 more)

### Community 2 - "Client Shell & Module Registry"
Cohesion: 0.06
Nodes (39): AccessDeniedScreen(), ForbiddenError, getMe(), PortalConfig, requestFormData(), setDevRole(), UnauthenticatedError, App() (+31 more)

### Community 3 - "Artifactory Upload UI"
Cohesion: 0.09
Nodes (29): FileEntry, getJob(), listJobs(), submitFolderUpload(), submitUrlCopy(), Tab, FolderUploadForm(), formatBytes() (+21 more)

### Community 4 - "CI/CD Pipeline & Ops Rationale"
Cohesion: 0.06
Nodes (40): Ticket form selectors have no name/type attributes, Playwright must be loaded via createRequire (CJS, not ESM), Playwright driver.mjs (headless module walkthrough), run-devops-portal skill, Vite port collision to 5174, act-runner pod with DinD sidecar, ArgoCD selfHeal auto-sync of devops-portal Application, k3d containerd must trust registry.homelab.local (+32 more)

### Community 5 - "Dev & Test Dependencies"
Cohesion: 0.05
Nodes (39): concurrently, jsdom, devDependencies, concurrently, jsdom, react, react-dom, supertest (+31 more)

### Community 6 - "Runtime Deps & npm Scripts"
Cohesion: 0.05
Nodes (37): cors, dotenv, express, highlight.js, lucide-react, multer, dependencies, cors (+29 more)

### Community 7 - "Whitening Packer & Gitea PRs"
Cohesion: 0.12
Nodes (16): adm-zip, adm-zip, execFileAsync, jfUpload(), GiteaApi, GiteaConfig, GiteaPullRequest, GiteaRepo (+8 more)

### Community 8 - "Ticketing Client UI"
Cohesion: 0.19
Nodes (27): request(), AdminTicketingView(), TicketRow(), addAdminComment(), addComment(), createTicket(), getAdminTicket(), getAssignees() (+19 more)

### Community 9 - "TypeScript Compiler Config"
Cohesion: 0.07
Nodes (27): DOM, DOM.Iterable, ES2022, node, src, @testing-library/jest-dom, vite.config.ts, vitest.config.ts (+19 more)

### Community 10 - "RAGFlow Chat UI"
Cohesion: 0.18
Nodes (11): getPortalConfig(), streamChat(), ChatView(), createSession(), loadActiveId(), loadSessions(), makeId(), MessageList() (+3 more)

### Community 11 - "Playwright Screenshot Driver"
Cohesion: 0.50
Nodes (4): { chromium }, require, run(), ss()

### Community 12 - "Mock Data Policy Exception"
Cohesion: 1.00
Nodes (3): In-memory ticket state cleared on restart, demoUsers + dev fallback user (temporary exception), No mock data in production code

## Ambiguous Edges - Review These
- `Whitening module (skopeo retag push, Gitea PRs)` → `build-export.tar.gz.png intentional filename`  [AMBIGUOUS]
  CLAUDE.md · relation: conceptually_related_to

## Knowledge Gaps
- **131 isolated node(s):** `auto-commit-push.sh script`, `require`, `{ chromium }`, `name`, `version` (+126 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Whitening module (skopeo retag push, Gitea PRs)` and `build-export.tar.gz.png intentional filename`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `dependencies` connect `Runtime Deps & npm Scripts` to `Whitening Packer & Gitea PRs`?**
  _High betweenness centrality (0.215) - this node is a cross-community bridge._
- **Why does `adm-zip` connect `Whitening Packer & Gitea PRs` to `Runtime Deps & npm Scripts`?**
  _High betweenness centrality (0.208) - this node is a cross-community bridge._
- **What connects `auto-commit-push.sh script`, `require`, `{ chromium }` to the rest of the system?**
  _131 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Ticketing Backend & Jira API` be split into smaller, more focused modules?**
  _Cohesion score 0.05168316831683168 - nodes in this community are weakly interconnected._
- **Should `Server App, Auth & Config` be split into smaller, more focused modules?**
  _Cohesion score 0.05314685314685315 - nodes in this community are weakly interconnected._
- **Should `Client Shell & Module Registry` be split into smaller, more focused modules?**
  _Cohesion score 0.06170598911070781 - nodes in this community are weakly interconnected._