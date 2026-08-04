import cors from "cors";
import express from "express";
import { z } from "zod";
import { isAdmin, requireSession, setDevRole } from "./auth";
import { config } from "./config";
import { devArtifactoryJobs } from "./modules/artifactory/devJobs";
import { RealArtifactoryApi } from "./modules/artifactory/RealArtifactoryApi";
import { createArtifactoryRouter } from "./modules/artifactory/router";
import { createRagflowRouter } from "./modules/ragflow/router";
import { InMemoryTicketingApi } from "./modules/ticketing/InMemoryTicketingApi";
import { JiraTicketingApi } from "./modules/ticketing/JiraTicketingApi";
import { createTicketingRouter } from "./modules/ticketing/router";
import { devWhiteningJobs } from "./modules/whitening/devJobs";
import { RealWhiteningApi } from "./modules/whitening/RealWhiteningApi";
import { createWhiteningRouter } from "./modules/whitening/router";
import { sweepOldTmpDirs } from "./tmp";
import type { ArtifactoryApi, TicketingApi, WhiteningApi } from "./types";

/**
 * Dev mode is "no SSO proxy in front" — the same switch that makes `auth.ts`
 * synthesize the `dev` user and opens `/api/dev/role`. The chart sets
 * `SSO_REQUIRED: "true"`, so no demo job is ever seeded in a deployment.
 */
const devMode = !config.ssoRequired;

export function createApp(
  ticketingApi: TicketingApi = config.jira.enabled ? new JiraTicketingApi(config.jira) : new InMemoryTicketingApi(),
  artifactoryApi: ArtifactoryApi = new RealArtifactoryApi(devMode ? devArtifactoryJobs() : []),
  whiteningApi: WhiteningApi = new RealWhiteningApi(devMode ? devWhiteningJobs() : [])
) {
  void sweepOldTmpDirs();
  if (devMode) {
    console.log("[dev] SSO_REQUIRED is not true — seeding demo Artifactory/Whitening jobs");
  }
  console.log(`[artifactory] url: ${config.artifactory.url || "(not set)"}, repo: ${config.artifactory.repo || "(not set)"}`);
  if (config.git.enabled) {
    console.log(`[whitening] Bitbucket PRs — url: ${config.git.url}`);
  } else {
    console.log("[whitening] not configured (set GIT_URL + GIT_TOKEN)");
  }
  if (config.jira.enabled) {
    console.log(`[ticketing] Jira backend — url: ${config.jira.baseUrl}, project: ${config.jira.projectKey}`);
  } else {
    console.log("[ticketing] in-memory fallback (set JIRA_URL + JIRA_TOKEN + JIRA_PROJECT_KEY for Jira)");
  }
  if (config.chat.enabled) {
    console.log(`[chat] url: ${config.chat.apiUrl}, model: ${config.chat.model}`);
  } else {
    console.log("[chat] not configured (set CHAT_API_URL + CHAT_API_KEY)");
  }

  const app = express();

  app.use(cors());
  app.use(express.json());

  // Public config — no secrets, no auth required
  app.get("/api/config", (_req, res) => {
    res.json({
      ssoUrl: config.ssoUrl,
      artifactoryEnabled: config.artifactory.enabled,
      chatEnabled: config.chat.enabled,
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
  app.use(createRagflowRouter());

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
