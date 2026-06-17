import cors from "cors";
import express from "express";
import { z } from "zod";
import { isAdmin, requireSession } from "./auth";
import { config } from "./config";
import { createArgoCdRouter } from "./modules/argocd/router";
import { RealArtifactoryApi } from "./modules/artifactory/RealArtifactoryApi";
import { createArtifactoryRouter } from "./modules/artifactory/router";
import { createBranchDiffRouter } from "./modules/branchdiff/router";
import { createRagflowRouter } from "./modules/ragflow/router";
import { InMemoryTicketingApi } from "./modules/ticketing/InMemoryTicketingApi";
import { JiraTicketingApi } from "./modules/ticketing/JiraTicketingApi";
import { createTicketingRouter } from "./modules/ticketing/router";
import type { ArtifactoryApi, TicketingApi } from "./types";

export function createApp(
  ticketingApi: TicketingApi = config.jira.enabled ? new JiraTicketingApi(config.jira) : new InMemoryTicketingApi(),
  artifactoryApi: ArtifactoryApi = new RealArtifactoryApi()
) {
  console.log(`[artifactory] Using jf CLI — url: ${config.artifactory.url || "(not set)"}, repo: ${config.artifactory.repo || "(not set)"}`);
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

  app.use(createTicketingRouter(ticketingApi));
  app.use(createArtifactoryRouter(artifactoryApi));
  app.use(createRagflowRouter());
  app.use(createArgoCdRouter());
  app.use(createBranchDiffRouter());

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
    if (error instanceof Error && (error.message.includes("Argo CD") || error.message.includes("Jira request failed"))) {
      res.status(502).json({ error: error.message });
      return;
    }
    console.error("[server] Unexpected error:", error);
    res.status(500).json({ error: "Unexpected server error" });
  });

  return app;
}
