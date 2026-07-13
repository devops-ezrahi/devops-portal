import type { NextFunction, Request, Response } from "express";
import { readFileSync } from "fs";
import https from "https";
import { config } from "./config";
import type { AssigneeCandidate, PortalUser } from "./types";

const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

// os4-chart's oauth-proxy sidecar (OpenShift's OAuthClient flow) has no
// groups-claim equivalent to Keycloak's, so it forwards the user's OAuth
// access token (X-Forwarded-Access-Token) instead of a groups header. We
// resolve groups the same way the cluster's own RBAC does — a TokenReview
// against the in-cluster API server, using this pod's own ServiceAccount as
// the reviewer (needs the tokenreviews.authentication.k8s.io "create"
// ClusterRole from os4-chart). status.user.groups includes AD-synced groups
// regardless of how they got into OpenShift. Never tested against a real
// OpenShift cluster — built from the TokenReview API shape and how
// Jenkins' openshift-login-plugin does the equivalent lookup.
// Best-effort only: returns [] on any failure so a TokenReview hiccup or
// running outside OpenShift (Keycloak path, local dev) never breaks login.
async function groupsViaTokenReview(accessToken: string): Promise<string[]> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) return [];

  let reviewerToken: string;
  let ca: Buffer;
  try {
    reviewerToken = readFileSync(SA_TOKEN_PATH, "utf8").trim();
    ca = readFileSync(SA_CA_PATH);
  } catch {
    return [];
  }

  const body = JSON.stringify({
    apiVersion: "authentication.k8s.io/v1",
    kind: "TokenReview",
    spec: { token: accessToken },
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        host,
        port,
        path: "/apis/authentication.k8s.io/v1/tokenreviews",
        method: "POST",
        ca,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${reviewerToken}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200 && res.statusCode !== 201) {
            console.error(`[auth] TokenReview failed: HTTP ${res.statusCode}`);
            resolve([]);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(parsed?.status?.authenticated ? (parsed.status.user?.groups ?? []) : []);
          } catch (err) {
            console.error("[auth] TokenReview response parse failed:", err);
            resolve([]);
          }
        });
      },
    );
    req.on("error", (err) => {
      console.error("[auth] TokenReview request failed:", err);
      resolve([]);
    });
    req.write(body);
    req.end();
  });
}

declare global {
  namespace Express {
    interface Request {
      user?: PortalUser;
    }
  }
}

function readHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

// oauth2-proxy comma-joins multiple groups into one X-Forwarded-Groups
// header value, which collides with LDAP/AD-style group DNs
// (CN=foo,OU=bar,DC=baz) that use commas as their own separator — naively
// splitting on "," shreds each DN into unmatched fragments. CN is always a
// DN's first component, so when DN syntax is present, pull group names out
// by CN= boundary instead; otherwise keep the plain comma-split (homelab's
// Keycloak groups aren't DNs).
function parseGroups(raw: string): string[] {
  if (/\bCN=/i.test(raw)) {
    return [...raw.matchAll(/CN=([^,]+)/gi)].map((m) => m[1].trim());
  }
  return raw
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
}

let devRole: "user" | "admin" = "user";

export function setDevRole(role: "user" | "admin") {
  devRole = role;
}

export function userFromSsoHeaders(req: Request): PortalUser | null {
  // Prefer headers injected by an SSO proxy (oauth2-proxy, Keycloak, etc.)
  const id = readHeader(req.headers["x-forwarded-user"]) ?? readHeader(req.headers["x-user-id"]);
  if (!id) return null;

  const email =
    readHeader(req.headers["x-forwarded-email"]) ??
    readHeader(req.headers["x-user-email"]) ??
    `${id}@example.com`;
  const displayName =
    readHeader(req.headers["x-forwarded-preferred-username"]) ??
    readHeader(req.headers["x-user-name"]) ??
    id;
  const rawGroups =
    readHeader(req.headers["x-forwarded-groups"]) ??
    readHeader(req.headers["x-user-groups"]) ??
    "";

  return {
    id,
    email,
    displayName,
    groups: parseGroups(rawGroups),
  };
}

export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const user = userFromSsoHeaders(req);

  if (!user) {
    if (config.ssoRequired) {
      res.status(401).json({ error: "Authentication required", ssoUrl: config.ssoUrl });
      return;
    }
    // Dev fallback: synthesize a user so the app works without an SSO proxy
    req.user = {
      id: "dev",
      email: "dev@example.com",
      displayName: "Dev User",
      groups: devRole === "admin" ? [config.adminGroups[0]] : [],
    };
  } else {
    req.user = user;

    const hasGroupsHeader =
      req.headers["x-forwarded-groups"] !== undefined || req.headers["x-user-groups"] !== undefined;
    const accessToken = readHeader(req.headers["x-forwarded-access-token"]);
    if (!hasGroupsHeader && accessToken) {
      req.user.groups = await groupsViaTokenReview(accessToken);
    }
  }

  if (config.allowedGroups.length > 0) {
    const userGroups = req.user!.groups;
    const allowed = config.allowedGroups.some((g) => userGroups.includes(g));
    if (!allowed) {
      res.status(403).json({ error: "Access denied: your group is not permitted to use this portal" });
      return;
    }
  }

  rememberUser(req.user!);
  next();
}

export function isAdmin(user: PortalUser) {
  return config.adminGroups.some((g) => user.groups.includes(g));
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !isAdmin(req.user)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

// ponytail: self-populating directory (who's logged in since this process
// started) rather than querying Keycloak's group-membership admin API. Good
// enough for "pick a ticket owner from the team" on a small roster; the
// ceiling is that someone who hasn't logged in yet won't show up until they
// do. Upgrade path: query GET /admin/realms/{realm}/groups/{id}/members via
// a Keycloak service-account client if that gap ever actually matters.
const knownUsers = new Map<string, PortalUser>();

export function rememberUser(user: PortalUser) {
  knownUsers.set(user.id, user);
}

export function listAdminCandidates(): AssigneeCandidate[] {
  return [...knownUsers.values()]
    .filter(isAdmin)
    .map((user) => ({ id: user.id, displayName: user.displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
