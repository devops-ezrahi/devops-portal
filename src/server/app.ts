import cors from "cors";
import express from "express";
import { z } from "zod";
import { isAdmin, requireSession, setDevRole } from "./auth";
import { config } from "./config";
import { RealArtifactoryApi } from "./modules/artifactory/RealArtifactoryApi";
import { createArtifactoryRouter } from "./modules/artifactory/router";
import { RealAiApi } from "./modules/ai/RealAiApi";
import { createAiRouter } from "./modules/ai/router";
import { InMemoryTicketingApi } from "./modules/ticketing/InMemoryTicketingApi";
import { JiraTicketingApi } from "./modules/ticketing/JiraTicketingApi";
import { createTicketingRouter } from "./modules/ticketing/router";
import { RealWhiteningApi } from "./modules/whitening/RealWhiteningApi";
import { createWhiteningRouter } from "./modules/whitening/router";
import { sweepOldTmpDirs } from "./tmp";
import type { ArtifactoryApi, AiApi, TicketingApi, WhiteningApi } from "./types";

export function createApp(
  ticketingApi: TicketingApi = config.jira.enabled ? new JiraTicketingApi(config.jira) : new InMemoryTicketingApi(),
  artifactoryApi: ArtifactoryApi = new RealArtifactoryApi(),
  whiteningApi: WhiteningApi = new RealWhiteningApi(),
  aiApi: AiApi = new RealAiApi()
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
  // The skills dir is always named, enabled or not: an empty registry is the
  // one failure here that is otherwise silent — the module just reports itself
  // "not configured" whether the path is wrong, unmounted, or holds entries
  // under the old research-* prefix.
  const projectNames = Object.keys(config.ai.projects);
  console.log(
    `[ai] skills dir: ${config.ai.skillsDir} — ${projectNames.length} ai-* project(s)` +
      `${projectNames.length ? `: ${projectNames.join(", ")}` : ""}`
  );
  if (config.ai.enabled) {
    console.log(
      `[ai] opencode model: ${config.ai.model}${config.ai.baseUrl ? ` via ${config.ai.baseUrl}` : ""}`
    );
  } else {
    console.log("[ai] not configured — no ai-* skills found in the directory above");
  }

  const app = express();

  app.use(cors());
  app.use(express.json());

  // Public config — no secrets, no auth required
  app.get("/api/config", (_req, res) => {
    res.json({
      ssoUrl: config.ssoUrl,
      artifactoryEnabled: config.artifactory.enabled,
      aiEnabled: config.ai.enabled,
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
  app.use(createAiRouter(aiApi));

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
    // multer aborts the request mid-stream once an upload passes its limit, and
    // otherwise surfaces as a bare 500 to a user who just spent minutes zipping.
    if (error instanceof Error && (error as { code?: string }).code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "Upload is too large — the limit is 500 MB." });
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
