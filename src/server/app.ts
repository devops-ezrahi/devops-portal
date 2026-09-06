import cors from "cors";
import express from "express";
import { z } from "zod";
import { isAdmin, requireSession, setDevRole } from "./auth";
import { config } from "./config";
import { log, requestLogger, userMessage } from "./log";
import { RealArtifactoryApi } from "./modules/artifactory/RealArtifactoryApi";
import { createArtifactoryRouter } from "./modules/artifactory/router";
import { RealAiApi } from "./modules/ai/RealAiApi";
import { createAiRouter } from "./modules/ai/router";
import { createArgocdRouter } from "./modules/argocd/router";
import { createJenkinsfileRouter } from "./modules/jenkinsfile/router";
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
  log.info("boot", "starting DevOps portal", {
    node: process.version,
    pid: process.pid,
    env: process.env.NODE_ENV ?? "development",
    logLevel: config.logLevel,
    sso: config.ssoRequired ? "required" : "off (dev fallback user)",
    adminGroups: config.adminGroups.join("|"),
    allowedGroups: config.allowedGroups.join("|") || "(everyone)",
  });
  // Dev mode is "no SSO proxy in front" — the same switch that makes `auth.ts`
  // synthesize the `dev` user and opens `/api/dev/role`. The chart sets
  // `SSO_REQUIRED: "true"`, so the Test buttons never exist in a deployment.
  if (!config.ssoRequired) {
    log.warn("boot", "SSO_REQUIRED is not true — /jobs/simulate is available (Test buttons)");
  }
  if (config.artifactory.enabled) {
    log.info("artifactory", "configured", {
      url: config.artifactory.url,
      npm: config.artifactory.npmRepo || "(not set)",
      maven: config.artifactory.mavenRepo || "(not set)",
      rpm: config.artifactory.rpmRepo || "(not set)",
      pypi: config.artifactory.pypiRepo || "(not set)",
      conda: config.artifactory.condaRepo || "(not set)",
      helm: config.artifactory.helmRepo || "(not set)",
      docker: config.artifactory.dockerRepo || "(not set)",
    });
  } else {
    log.warn("artifactory", "disabled — set ARTIFACTORY_URL + ARTIFACTORY_REPO + ARTIFACTORY_TOKEN", {
      url: config.artifactory.url || "(not set)",
      repo: config.artifactory.repo || "(not set)",
      token: config.artifactory.token ? "set" : "(not set)",
    });
  }
  if (config.git.enabled) {
    log.info("whitening", "Bitbucket PRs enabled", { url: config.git.url });
  } else {
    log.warn("whitening", "PRs disabled — set GIT_URL + GIT_TOKEN");
  }
  if (config.jira.enabled) {
    log.info("ticketing", "Jira backend", {
      url: config.jira.baseUrl,
      project: config.jira.projectKey,
      label: config.jira.ticketLabel || "(whole project)",
      storyPoints: config.jira.storyPointsField || "(portal-only, set JIRA_STORY_POINTS_FIELD)",
    });
  } else {
    log.warn("ticketing", "in-memory fallback — set JIRA_URL + JIRA_TOKEN + JIRA_PROJECT_KEY for Jira");
  }
  // The skills dir is always named, enabled or not: an empty registry is the
  // one failure here that is otherwise silent — the module just reports itself
  // "not configured" whether the path is wrong, unmounted, or holds entries
  // under the old research-* prefix.
  const projectNames = Object.keys(config.ai.projects);
  log[config.ai.enabled ? "info" : "warn"]("ai", `${projectNames.length} ai-* project(s)`, {
    skillsDir: config.ai.skillsDir,
    projects: projectNames.join(", ") || "(none — module disabled)",
    model: config.ai.enabled ? config.ai.model : undefined,
    baseUrl: config.ai.enabled ? config.ai.baseUrl : undefined,
  });

  const app = express();

  // exposedHeaders: a custom response header is invisible to JS on a
  // cross-origin response unless it is named here, and the browser console's
  // correlation id (`ref`) is read straight off it.
  app.use(cors({ exposedHeaders: ["X-Request-Id"] }));
  app.use(express.json());
  app.use(requestLogger);

  // Public config — no secrets, no auth required. The 401 body carries ssoUrl,
  // so this is only what a signed-out page still needs to know.
  app.get("/api/config", (_req, res) => {
    res.json({ aiEnabled: config.ai.enabled });
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
  // One implementation and no config to select on, so the router owns its store
  // rather than taking an injected API like the four above.
  app.use(createJenkinsfileRouter());
  app.use(createArgocdRouter());

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const where = { id: req.id, user: req.user?.id ?? "-", route: `${req.method} ${req.originalUrl}` };
    /**
     * Every error response carries the same `requestId` the http line logged, so
     * a screenshot of the UI message is enough to find the request in the pod
     * log. 4xx is the caller's problem and logs one warn line; 5xx is ours and
     * gets the stack plus the full `.cause` chain.
     */
    const fail = (status: number, message: string, details?: unknown) => {
      if (status >= 500) log.error("http", `${status} ${message}`, error, where);
      else log.warn("http", `${status} ${message}`, where);
      res.status(status).json({ error: message, requestId: req.id, ...(details === undefined ? {} : { details }) });
    };

    if (error instanceof z.ZodError) {
      fail(400, "Validation failed", z.treeifyError(error));
      return;
    }
    if (error instanceof Error && error.message.includes("Unknown request type")) {
      fail(400, error.message);
      return;
    }
    if (error instanceof Error && error.message === "Ticket not found") {
      fail(404, error.message);
      return;
    }
    if (error instanceof Error && error.message === "Job not found") {
      fail(404, error.message);
      return;
    }
    // Cancelling someone else's job.
    if (error instanceof Error && error.message.startsWith("Forbidden")) {
      fail(403, error.message);
      return;
    }
    // Whitening's multer aborts the request mid-stream once an upload passes its
    // limit, and otherwise surfaces as a bare 500. (Artifactory's folder upload
    // arrives in parts and answers 413 itself.)
    if (error instanceof Error && (error as { code?: string }).code === "LIMIT_FILE_SIZE") {
      fail(413, "Upload is too large — the limit is 500 MB.");
      return;
    }
    if (error instanceof Error && error.message.includes("Jira request failed")) {
      fail(502, error.message);
      return;
    }
    if (error instanceof Error) {
      // Node's fetch() throws a bare "fetch failed" TypeError and buries the
      // actual reason (ECONNREFUSED, ENOTFOUND, self-signed cert, ...) in .cause
      // — describeError walks the whole chain so the message the developer sees
      // names the actual failure instead of "fetch failed".
      fail(500, userMessage(error));
      return;
    }
    fail(500, "Unexpected server error");
  });

  return app;
}
