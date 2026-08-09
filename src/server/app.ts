import cors from "cors";
import express from "express";
import { z } from "zod";
import { isAdmin, requireSession, setDevRole } from "./auth";
import { config } from "./config";
import { RealArtifactoryApi } from "./modules/artifactory/RealArtifactoryApi";
import { createArtifactoryRouter } from "./modules/artifactory/router";
import { RealResearchApi } from "./modules/research/RealResearchApi";
import { createResearchRouter } from "./modules/research/router";
import { InMemoryTicketingApi } from "./modules/ticketing/InMemoryTicketingApi";
import { JiraTicketingApi } from "./modules/ticketing/JiraTicketingApi";
import { createTicketingRouter } from "./modules/ticketing/router";
import { RealWhiteningApi } from "./modules/whitening/RealWhiteningApi";
import { createWhiteningRouter } from "./modules/whitening/router";
import { sweepOldTmpDirs } from "./tmp";
import type { ArtifactoryApi, ResearchApi, TicketingApi, WhiteningApi } from "./types";

export function createApp(
  ticketingApi: TicketingApi = config.jira.enabled ? new JiraTicketingApi(config.jira) : new InMemoryTicketingApi(),
  artifactoryApi: ArtifactoryApi = new RealArtifactoryApi(),
  whiteningApi: WhiteningApi = new RealWhiteningApi(),
  researchApi: ResearchApi = new RealResearchApi()
) {
  void sweepOldTmpDirs();
  // Dev mode is "no SSO proxy in front" — the same switch that makes `auth.ts`
  // synthesize the `dev` user and opens `/api/dev/role`. The chart sets
  // `SSO_REQUIRED: "true"`, so the Test buttons never exist in a deployment.
  if (!config.ssoRequired) {
    console.log("[dev] SSO_REQUIRED is not true — /jobs/simulate is available (Test buttons)");
  }
  console.log(`[artifactory] url: ${config.artifactory.url || "(not set)"}, repo: ${config.artifactory.repo || "(not set)"}`);
  if (config.git.enabled) {
    console.log(`[whitening] Bitbucket PRs — url: ${config.git.url}`);
  } else {
    console.log("[whitening] not configured (set GIT_URL + GIT_TOKEN)");
  }
  if (config.jira.enabled) {
    console.log(`[ticketing] Jira backend — url: ${config.jira.baseUrl}, project: ${config.jira.projectKey}`);
    console.log(
      config.jira.storyPointsField
        ? `[ticketing] story points → ${config.jira.storyPointsField}`
        : "[ticketing] story points not synced to Jira (set JIRA_STORY_POINTS_FIELD)"
    );
  } else {
    console.log("[ticketing] in-memory fallback (set JIRA_URL + JIRA_TOKEN + JIRA_PROJECT_KEY for Jira)");
  }
  if (config.research.enabled) {
    console.log(
      `[research] opencode model: ${config.research.model}, projects: ${Object.keys(config.research.projects).join(", ") || "(none)"}`
    );
  } else {
    console.log("[research] not configured (set RESEARCH_PROJECTS + OPENCODE_API_KEY)");
  }

  const app = express();

  app.use(cors());
  app.use(express.json());

  // Public config — no secrets, no auth required
  app.get("/api/config", (_req, res) => {
    res.json({
      ssoUrl: config.ssoUrl,
      artifactoryEnabled: config.artifactory.enabled,
      researchEnabled: config.research.enabled,
    });
  });

  app.use("/api", requireSession);

  app.get("/api/me", (req, res) => {
    res.json({ user: req.user, isAdmin: isAdmin(req.user!) });
  });

  app.post("/api/dev/role", (req, res) => {
    if (config.ssoRequired) { res.status(403).json({ error: "Not available in SSO mode" }); return; }
    const { role } = req.body as { role?: string };
    if (role !== "user" && role !== "admin") { res.status(400).json({ error: "role must be 'user' or 'admin'" }); return; }
    setDevRole(role);
    res.json({ ok: true, role });
  });

  app.use(createTicketingRouter(ticketingApi));
  app.use(createArtifactoryRouter(artifactoryApi));
  app.use(createWhiteningRouter(whiteningApi));
  app.use(createResearchRouter(researchApi));

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: z.treeifyError(error) });
      return;
    }
    if (error instanceof Error && error.message.includes("Unknown request type")) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message === "Ticket not found") {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message === "Job not found") {
      res.status(404).json({ error: error.message });
      return;
    }
    // Cancelling someone else's job.
    if (error instanceof Error && error.message.startsWith("Forbidden")) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes("Jira request failed")) {
      res.status(502).json({ error: error.message });
      return;
    }
    console.error("[server] Unexpected error:", error);
    if (error instanceof Error) {
      // Node's fetch() throws a bare "fetch failed" TypeError and buries the
      // actual reason (ECONNREFUSED, ENOTFOUND, self-signed cert, ...) in .cause.
      const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
      res.status(500).json({ error: `${error.message}${cause}` });
      return;
    }
    res.status(500).json({ error: "Unexpected server error" });
  });

  return app;
}
