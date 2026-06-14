import type { Request } from "express";
import type {
  ArgoCdApplicationSummary,
  ArgoCdDashboard,
  ArgoCdDashboardTotals,
  ArgoCdProjectSummary,
  ArgoCdPromotionGroup
} from "../../types";

type ArgoCdProject = {
  metadata?: {
    name?: string;
  };
  spec?: {
    description?: string;
    sourceRepos?: string[];
    destinations?: Array<{ server?: string; namespace?: string }>;
    orphanedResources?: {
      warn?: boolean;
    };
  };
};

type ArgoCdApplication = {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: {
    project?: string;
    source?: {
      repoURL?: string;
      targetRevision?: string;
      path?: string;
      chart?: string;
      helm?: {
        parameters?: Array<{ name?: string; value?: string }>;
        valuesObject?: Record<string, unknown>;
      };
    };
    destination?: {
      server?: string;
      namespace?: string;
    };
    syncPolicy?: {
      automated?: {
        prune?: boolean;
        selfHeal?: boolean;
        allowEmpty?: boolean;
      };
    };
  };
  status?: {
    sync?: {
      status?: string;
    };
    health?: {
      status?: string;
      message?: string;
    };
    operationState?: {
      phase?: string;
      message?: string;
      startedAt?: string;
      finishedAt?: string;
      operation?: {
        initiatedBy?: {
          username?: string;
          automated?: boolean;
        };
        sync?: {
          revision?: string;
        };
      };
      syncResult?: {
        revision?: string;
        resources?: Array<{
          kind?: string;
          name?: string;
          namespace?: string;
          status?: string;
          message?: string;
        }>;
      };
    };
    history?: Array<{
      revision?: string;
      deployedAt?: string;
      deployStartedAt?: string;
      initiatedBy?: {
        username?: string;
        automated?: boolean;
      };
    }>;
    resources?: Array<{
      kind?: string;
      name?: string;
      namespace?: string;
      status?: string;
      health?: {
        status?: string;
        message?: string;
      };
    }>;
    summary?: {
      images?: string[];
    };
    reconciledAt?: string;
  };
};

type ArgoCdListResponse<T> = {
  items?: T[];
};

const defaultArgoCdUrl = "https://127.0.0.1:8081";

type ArgoCdConfig = {
  id: string;
  name: string;
  url: string;
  authMode: "token" | "basic" | "sso";
  authToken?: string;
  username?: string;
  password?: string;
  insecure?: boolean;
};

function cleanUrl(url: string) {
  return url.replace(/\/$/, "");
}

function resolveSecretReference(value?: string) {
  if (!value) {
    return value;
  }
  const match = value.match(/^\$\{([A-Z0-9_]+)\}$/i);
  return match ? process.env[match[1]] : value;
}

function configuredArgoCd(): ArgoCdConfig {
  const url = cleanUrl(process.env.ARGOCD_URL ?? defaultArgoCdUrl);
  const authMode: ArgoCdConfig["authMode"] = process.env.ARGOCD_AUTH_TOKEN
    ? "token"
    : process.env.ARGOCD_USERNAME && process.env.ARGOCD_PASSWORD
      ? "basic"
      : "sso";

  return {
    id: process.env.ARGOCD_INSTANCE_ID ?? "default",
    name: process.env.ARGOCD_INSTANCE_NAME ?? "Configured Argo CD",
    url,
    authMode,
    authToken: resolveSecretReference(process.env.ARGOCD_AUTH_TOKEN),
    username: resolveSecretReference(process.env.ARGOCD_USERNAME),
    password: resolveSecretReference(process.env.ARGOCD_PASSWORD),
    insecure: process.env.ARGOCD_INSECURE === "true"
  };
}

function argoCdHeaders(req: Request, token?: string) {
  const headers: Record<string, string> = {
    Accept: "application/json"
  };
  const forwardedAuth = req.headers.authorization;
  const cookie = req.headers.cookie;

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else if (forwardedAuth) {
    headers.Authorization = Array.isArray(forwardedAuth) ? forwardedAuth[0] : forwardedAuth;
  }

  if (cookie) {
    headers.Cookie = Array.isArray(cookie) ? cookie[0] : cookie;
  }

  return headers;
}

async function requestArgoCd<T>(config: ArgoCdConfig, path: string, options: RequestInit = {}) {
  if (config.insecure) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  let response: Response;
  try {
    response = await fetch(`${config.url}${path}`, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "connection failed";
    throw new Error(`Argo CD request failed for ${config.url}${path}: ${message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Argo CD request failed: ${response.status}`);
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Argo CD response could not be parsed: ${message}`);
  }
}

function annotation(app: ArgoCdApplication, key: string) {
  return app.metadata?.annotations?.[key] ?? "";
}

function label(app: ArgoCdApplication, key: string) {
  return app.metadata?.labels?.[key] ?? "";
}

function firstValue(...values: Array<string | undefined>) {
  return values.find((value) => value && value.trim().length > 0)?.trim() ?? "";
}

function inferEnvironment(app: ArgoCdApplication): ArgoCdApplicationSummary["environment"] {
  const raw = firstValue(
    annotation(app, "portal.devops/environment"),
    label(app, "environment"),
    label(app, "env"),
    app.spec?.destination?.namespace,
    app.metadata?.name
  ).toLowerCase();

  if (/\b(prd|prod|production)\b/.test(raw)) {
    return "prd";
  }
  if (/\b(preprod|pre-prod|stage|stg)\b/.test(raw)) {
    return "preprod";
  }
  if (/\b(tst|test|qa)\b/.test(raw)) {
    return "tst";
  }
  if (/\b(dev|develop|development)\b/.test(raw)) {
    return "dev";
  }
  return "unknown";
}

function repoName(repoUrl: string) {
  const clean = repoUrl.replace(/\.git$/, "");
  return clean.split("/").filter(Boolean).at(-1) ?? repoUrl;
}

function normalizeGitUrl(repoUrl: string) {
  return repoUrl.replace(/\.git$/, "");
}

function gitPathUrl(repoUrl: string, revision: string, path: string) {
  const normalized = normalizeGitUrl(repoUrl);
  if (!normalized || !path) {
    return normalized;
  }
  if (normalized.includes("github.com")) {
    return `${normalized}/tree/${revision || "HEAD"}/${path}`;
  }
  return normalized;
}

function gitCommitUrl(repoUrl: string, revision: string) {
  const normalized = normalizeGitUrl(repoUrl);
  if (!normalized || !revision || revision === "HEAD") {
    return "";
  }
  if (normalized.includes("github.com")) {
    return `${normalized}/commit/${revision}`;
  }
  return normalized;
}

function helmParameter(app: ArgoCdApplication, name: string) {
  return app.spec?.source?.helm?.parameters?.find((parameter) => parameter.name === name)?.value ?? "";
}

function helmValue(app: ArgoCdApplication, path: string) {
  const parts = path.split(".");
  let current: unknown = app.spec?.source?.helm?.valuesObject;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return "";
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" || typeof current === "number" ? String(current) : "";
}

function desiredImage(app: ArgoCdApplication) {
  const imageRepo = firstValue(
    annotation(app, "portal.devops/image-repository"),
    helmParameter(app, "image.repository"),
    helmValue(app, "image.repository")
  );
  const imageTag = firstValue(annotation(app, "portal.devops/image-tag"), helmParameter(app, "image.tag"), helmValue(app, "image.tag"));
  return firstValue(annotation(app, "portal.devops/desired-image"), imageRepo && imageTag ? `${imageRepo}:${imageTag}` : imageRepo);
}

function liveImage(app: ArgoCdApplication) {
  return firstValue(annotation(app, "portal.devops/live-image"), app.status?.summary?.images?.[0]);
}

function syncDurationSeconds(app: ArgoCdApplication) {
  const started = app.status?.operationState?.startedAt;
  const finished = app.status?.operationState?.finishedAt;
  if (!started || !finished) {
    return undefined;
  }
  const duration = Math.round((new Date(finished).getTime() - new Date(started).getTime()) / 1000);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function outOfSyncReason(app: ArgoCdApplication) {
  const explicit = annotation(app, "portal.devops/out-of-sync-reason");
  if (explicit) {
    return explicit;
  }
  if (app.status?.sync?.status !== "OutOfSync") {
    return "No drift detected";
  }
  const messages =
    app.status?.resources
      ?.filter((resource) => resource.status && resource.status !== "Synced")
      .slice(0, 3)
      .map((resource) => `${resource.kind ?? "Resource"} ${resource.name ?? ""} ${resource.status}`.trim()) ?? [];
  return messages.length > 0 ? messages.join("; ") : "Resource drift detected";
}

function healthReason(app: ArgoCdApplication) {
  const explicit = annotation(app, "portal.devops/health-reason");
  if (explicit) {
    return explicit;
  }
  if (app.status?.health?.message) {
    return app.status.health.message;
  }
  const degraded =
    app.status?.resources?.find((resource) => resource.health?.status && resource.health.status !== "Healthy") ??
    app.status?.resources?.find((resource) => resource.status && resource.status !== "Synced");
  if (degraded) {
    return `${degraded.kind ?? "Resource"} ${degraded.name ?? ""}: ${degraded.health?.message ?? degraded.health?.status ?? degraded.status}`.trim();
  }
  return app.status?.health?.status === "Healthy" ? "All tracked resources are healthy" : "No health details reported";
}

function baselineStatus(app: ArgoCdApplication, chartVersion: string, baselineVersion: string): ArgoCdApplicationSummary["baselineStatus"] {
  const explicit = annotation(app, "portal.devops/baseline-status").toLowerCase();
  if (explicit === "ok" || explicit === "drift" || explicit === "override") {
    return explicit;
  }
  if (!chartVersion || !baselineVersion) {
    return "unknown";
  }
  if (annotation(app, "portal.devops/chart-override") === "true") {
    return "override";
  }
  return chartVersion === baselineVersion ? "ok" : "drift";
}

function approvalStatus(app: ArgoCdApplication): ArgoCdApplicationSummary["approvalStatus"] {
  const explicit = annotation(app, "portal.devops/approval-status").toLowerCase();
  if (explicit === "open" || explicit === "waiting-approval" || explicit === "approved-not-merged" || explicit === "merged-not-synced" || explicit === "synced") {
    return explicit;
  }
  return app.status?.sync?.status === "OutOfSync" ? "merged-not-synced" : "synced";
}

function riskWarnings(app: ArgoCdApplicationSummary) {
  const warnings: string[] = [];
  if (app.environment === "prd" && app.automated) warnings.push("Production auto-sync enabled");
  if (app.environment === "prd" && app.prune) warnings.push("Production prune enabled");
  if (app.environment === "prd" && app.selfHeal) warnings.push("Production self-heal enabled");
  if (app.criticality === "critical" && app.healthStatus !== "Healthy") warnings.push("Critical app degraded");
  if (app.criticality === "critical" && !app.owner) warnings.push("Critical app has no owner");
  if (app.baselineStatus === "drift") warnings.push("Chart drift from approved baseline");
  if (app.baselineStatus === "override") warnings.push("Temporary chart override");
  if (app.overrideExpiresAt && new Date(app.overrideExpiresAt).getTime() < Date.now()) warnings.push("Chart override expired");
  if (app.approvalStatus === "merged-not-synced") warnings.push("Merged change not synced");
  if (app.lastSyncResult === "Failed" || app.lastSyncResult === "Error") warnings.push("Last sync failed");
  if (app.imageDrift) warnings.push("Desired image differs from live image");
  if (app.syncStatus === "OutOfSync") warnings.push(app.outOfSyncReason);
  return warnings.filter(Boolean);
}

function riskScore(app: ArgoCdApplicationSummary) {
  return app.riskWarnings.reduce((score, warning) => {
    if (warning.includes("Production")) return score + 5;
    if (warning.includes("Critical")) return score + 5;
    if (warning.includes("failed")) return score + 4;
    if (warning.includes("drift") || warning.includes("baseline")) return score + 3;
    return score + 2;
  }, app.environment === "prd" ? 2 : 0);
}

async function getConfiguredToken(req: Request, config: ArgoCdConfig) {
  if (config.authToken) {
    return config.authToken;
  }

  if (!config.username || !config.password) {
    return undefined;
  }

  const session = await requestArgoCd<{ token: string }>(config, "/api/v1/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...argoCdHeaders(req)
    },
    body: JSON.stringify({
      username: config.username,
      password: config.password
    })
  });

  return session.token;
}

function summarizeApplication(app: ArgoCdApplication, config: ArgoCdConfig): ArgoCdApplicationSummary {
  const environment = inferEnvironment(app);
  const repoUrl = app.spec?.source?.repoURL ?? "";
  const targetRevision = app.spec?.source?.targetRevision ?? "HEAD";
  const path = app.spec?.source?.path ?? "";
  const automated = Boolean(app.spec?.syncPolicy?.automated);
  const chartName = firstValue(annotation(app, "portal.devops/chart-name"), app.spec?.source?.chart, "universal-microservice");
  const chartVersion = firstValue(annotation(app, "portal.devops/chart-version"), helmParameter(app, "chart.version"), helmValue(app, "chart.version"), "unknown");
  const baselineVersion = firstValue(
    annotation(app, "portal.devops/baseline-version"),
    process.env[`ARGOCD_BASELINE_${environment.toUpperCase()}`],
    chartVersion
  );
  const desired = desiredImage(app);
  const live = liveImage(app);
  const lastRevision =
    app.status?.operationState?.syncResult?.revision ??
    app.status?.operationState?.operation?.sync?.revision ??
    app.status?.history?.at(-1)?.revision ??
    targetRevision;

  const summary: ArgoCdApplicationSummary = {
    name: app.metadata?.name ?? "unknown",
    namespace: app.metadata?.namespace ?? "argocd",
    project: app.spec?.project ?? "default",
    environment,
    team: firstValue(annotation(app, "portal.devops/team"), label(app, "team"), label(app, "app.kubernetes.io/part-of"), "unowned"),
    owner: firstValue(annotation(app, "portal.devops/owner"), label(app, "owner")),
    criticality: firstValue(annotation(app, "portal.devops/criticality"), label(app, "criticality")).toLowerCase() === "critical" ? "critical" : "regular",
    repoUrl,
    repoName: repoName(repoUrl),
    repoPathUrl: gitPathUrl(repoUrl, targetRevision, path),
    commitUrl: gitCommitUrl(repoUrl, lastRevision),
    targetRevision,
    path,
    lastCommitHash: firstValue(annotation(app, "portal.devops/commit-hash"), lastRevision),
    lastCommitMessage: firstValue(annotation(app, "portal.devops/commit-message"), "Commit metadata unavailable"),
    lastCommitAuthor: firstValue(annotation(app, "portal.devops/commit-author"), "Unknown"),
    lastCommitAt: firstValue(annotation(app, "portal.devops/commit-time"), app.status?.reconciledAt),
    destinationServer: app.spec?.destination?.server ?? "",
    destinationNamespace: app.spec?.destination?.namespace ?? "",
    syncStatus: app.status?.sync?.status ?? "Unknown",
    healthStatus: app.status?.health?.status ?? "Unknown",
    healthReason: healthReason(app),
    outOfSyncReason: outOfSyncReason(app),
    automated,
    manualSyncRequired: environment === "prd" || !automated,
    prune: Boolean(app.spec?.syncPolicy?.automated?.prune),
    selfHeal: Boolean(app.spec?.syncPolicy?.automated?.selfHeal),
    allowEmpty: Boolean(app.spec?.syncPolicy?.automated?.allowEmpty),
    lastSyncedAt: app.status?.operationState?.finishedAt ?? app.status?.history?.at(-1)?.deployedAt,
    lastSyncResult: app.status?.operationState?.phase ?? "Unknown",
    lastSyncTriggeredBy: firstValue(
      app.status?.operationState?.operation?.initiatedBy?.username,
      app.status?.history?.at(-1)?.initiatedBy?.username,
      automated ? "Argo CD automation" : "Unknown"
    ),
    lastSyncRevision: lastRevision,
    lastSyncDurationSeconds: syncDurationSeconds(app),
    syncMode: automated ? "auto" : "manual",
    chartName,
    chartVersion,
    baselineVersion,
    baselineName: `${environment} baseline ${baselineVersion}`,
    baselineStatus: baselineStatus(app, chartVersion, baselineVersion),
    chartOverride: annotation(app, "portal.devops/chart-override") === "true",
    overrideReason: annotation(app, "portal.devops/override-reason"),
    overrideExpiresAt: annotation(app, "portal.devops/override-expires-at") || undefined,
    overrideApprovalOwner: annotation(app, "portal.devops/override-approval-owner"),
    desiredImage: desired || "Unknown",
    liveImage: live || desired || "Unknown",
    imageDigest: firstValue(annotation(app, "portal.devops/image-digest")),
    imageDrift: Boolean(desired && live && desired !== live),
    openPrCount: Number(annotation(app, "portal.devops/open-pr-count") || 0),
    approvalStatus: approvalStatus(app),
    lastApprovedPr: annotation(app, "portal.devops/last-approved-pr"),
    prAuthor: annotation(app, "portal.devops/pr-author"),
    requiredReviewers: annotation(app, "portal.devops/required-reviewers").split(",").map((reviewer) => reviewer.trim()).filter(Boolean),
    missingReviewers: annotation(app, "portal.devops/missing-reviewers").split(",").map((reviewer) => reviewer.trim()).filter(Boolean),
    riskScore: 0,
    riskWarnings: [],
    links: {
      argoCd: `${config.url}/applications/${app.metadata?.namespace ?? "argocd"}/${app.metadata?.name ?? ""}`,
      git: gitPathUrl(repoUrl, targetRevision, path),
      commit: gitCommitUrl(repoUrl, lastRevision)
    }
  };
  summary.riskWarnings = riskWarnings(summary);
  summary.riskScore = riskScore(summary);
  return summary;
}

function summarizeProject(project: ArgoCdProject, applications: ArgoCdApplicationSummary[]): ArgoCdProjectSummary {
  const name = project.metadata?.name ?? "default";
  const projectApps = applications.filter((app) => app.project === name);

  return {
    name,
    description: project.spec?.description ?? "",
    sourceRepos: project.spec?.sourceRepos ?? [],
    destinations: (project.spec?.destinations ?? []).map((destination) => ({
      server: destination.server ?? "",
      namespace: destination.namespace ?? ""
    })),
    orphanedResourcesEnabled: Boolean(project.spec?.orphanedResources?.warn),
    applicationCount: projectApps.length,
    syncedCount: projectApps.filter((app) => app.syncStatus === "Synced").length,
    outOfSyncCount: projectApps.filter((app) => app.syncStatus === "OutOfSync").length,
    healthyCount: projectApps.filter((app) => app.healthStatus === "Healthy").length,
    degradedCount: projectApps.filter((app) => app.healthStatus === "Degraded").length,
    applications: projectApps
  };
}

function dashboardTotals(projects: ArgoCdProjectSummary[], applications: ArgoCdApplicationSummary[]): ArgoCdDashboardTotals {
  return {
    applications: applications.length,
    outOfSync: applications.filter((app) => app.syncStatus === "OutOfSync").length,
    degraded: applications.filter((app) => app.healthStatus === "Degraded").length,
    criticalApps: applications.filter((app) => app.criticality === "critical").length,
    prodApps: applications.filter((app) => app.environment === "prd").length,
    autoSyncEnabled: applications.filter((app) => app.automated).length,
    waitingForSync: applications.filter((app) => app.approvalStatus === "merged-not-synced").length,
    failedSync: applications.filter((app) => app.lastSyncResult === "Failed" || app.lastSyncResult === "Error").length,
    openPrs: applications.reduce((count, app) => count + app.openPrCount, 0),
    notOnBaseline: applications.filter((app) => app.baselineStatus === "drift" || app.baselineStatus === "override").length,
    chartDrift: applications.filter((app) => app.baselineStatus === "drift").length,
    productionRisks: applications.filter((app) => app.environment === "prd" && app.riskWarnings.length > 0).length
  };
}

function promotionGroups(applications: ArgoCdApplicationSummary[]): ArgoCdPromotionGroup[] {
  const groups = new Map<string, ArgoCdApplicationSummary[]>();
  for (const app of applications) {
    const baseName = app.name.replace(/-(dev|tst|test|qa|preprod|stage|stg|prd|prod|production)$/i, "");
    groups.set(baseName, [...(groups.get(baseName) ?? []), app]);
  }

  return Array.from(groups.entries())
    .map(([name, apps]) => {
      const environments = apps
        .map((app) => ({
          environment: app.environment,
          image: app.desiredImage,
          chartVersion: app.chartVersion,
          syncStatus: app.syncStatus,
          healthStatus: app.healthStatus,
          approvalStatus: app.approvalStatus
        }))
        .sort((first, second) => ["dev", "tst", "preprod", "prd", "unknown"].indexOf(first.environment) - ["dev", "tst", "preprod", "prd", "unknown"].indexOf(second.environment));
      const prod = environments.find((environment) => environment.environment === "prd");
      const preprod = environments.find((environment) => environment.environment === "preprod");
      return {
        name,
        environments,
        prodBehind: Boolean(prod && preprod && prod.image !== preprod.image)
      };
    })
    .filter((group) => group.environments.length > 1 || group.environments.some((environment) => environment.environment === "prd"));
}

export async function listArgoCdProjects(req: Request): Promise<ArgoCdDashboard> {
  const config = configuredArgoCd();
  const token = await getConfiguredToken(req, config);
  const headers = argoCdHeaders(req, token);
  const [projectResult, applicationResult] = await Promise.all([
    requestArgoCd<ArgoCdListResponse<ArgoCdProject>>(config, "/api/v1/projects", { headers }),
    requestArgoCd<ArgoCdListResponse<ArgoCdApplication>>(config, "/api/v1/applications", { headers })
  ]);

  const applications = (applicationResult.items ?? [])
    .map((app) => summarizeApplication(app, config))
    .sort((first, second) => second.riskScore - first.riskScore || first.name.localeCompare(second.name));

  const projects = (projectResult.items ?? [])
    .map((project) => summarizeProject(project, applications))
    .sort((first, second) => first.name.localeCompare(second.name));

  return {
    instance: {
      id: config.id,
      name: config.name,
      url: config.url,
      authMode: config.authMode
    },
    projects,
    applications,
    totals: dashboardTotals(projects, applications),
    promotion: promotionGroups(applications)
  };
}
