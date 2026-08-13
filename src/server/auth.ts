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

/**
 * Node parses header bytes as latin-1, so a UTF-8 name — Hebrew, Cyrillic,
 * anything accented — arrives mojibaked ("×“×‘×™" rather than "דבי").
 * Reinterpreting the same bytes as UTF-8 recovers it.
 *
 * Only applied when the value actually contains high bytes and decodes without
 * a replacement character, so a name that really is latin-1 is left untouched
 * rather than mangled the other way.
 */
export function decodeHeaderText(value: string): string {
  if (!/[-ÿ]/.test(value)) return value;
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  return decoded.includes("�") ? value : decoded;
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
  // SSO_NAME_HEADER first, so a deployment can point at whichever header its
  // proxy carries the IdP's `name` claim in — oauth2-proxy's own passthrough
  // header name differs by configuration, and the claim is a person's full
  // name rather than the username the two fallbacks below hold.
  const displayName = decodeHeaderText(
    (config.ssoNameHeader ? readHeader(req.headers[config.ssoNameHeader]) : undefined) ??
      readHeader(req.headers["x-forwarded-preferred-username"]) ??
      readHeader(req.headers["x-user-name"]) ??
      id
  );
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
  }

  if (config.allowedGroups.length > 0 && !isAdmin(req.user!)) {
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

// The one place a user's name is decided. Ticket records carry a name
// snapshot taken whenever the assignment was made, which drifts from what
// /api/me reports — and is an empty string when the assigner's roster didn't
// have that user, leaving the UI to fall back on the raw id (a Keycloak sub
// UUID). Resolve against the live directory first so every surface shows the
// same string; the snapshot is only a fallback for users this process hasn't
// seen since it started.
export function displayNameFor(id: string, storedName = ""): string {
  if (!id) return storedName;
  return knownUsers.get(id)?.displayName || storedName || id;
}

export function listAdminCandidates(): AssigneeCandidate[] {
  return [...knownUsers.values()]
    .filter(isAdmin)
    .map((user) => ({ id: user.id, displayName: user.displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
