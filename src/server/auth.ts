import type { NextFunction, Request, Response } from "express";
import { config } from "./config";
import type { AssigneeCandidate, PortalUser } from "./types";

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
    groups: rawGroups
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
  };
}

export function requireSession(req: Request, res: Response, next: NextFunction) {
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
