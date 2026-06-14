import type { NextFunction, Request, Response } from "express";
import { config } from "./config";
import type { PortalUser } from "./types";

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
      id: "u-alex",
      email: "alex@example.com",
      displayName: "Alex Morgan",
      groups: ["team-alpha"],
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
