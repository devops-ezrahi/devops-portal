import { error as logError } from "./log";
import type { PortalUser } from "../server/types";

export type PortalConfig = {
  ssoRequired: boolean;
  ssoUrl: string;
  artifactoryEnabled: boolean;
  aiEnabled: boolean;
};

export class UnauthenticatedError extends Error {
  readonly ssoUrl: string;
  constructor(ssoUrl: string) {
    super("Authentication required");
    this.name = "UnauthenticatedError";
    this.ssoUrl = ssoUrl;
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Carries what the server actually said: its status, the `requestId` that the
 * same request logged in the pod (`kubectl logs | grep <ref>`), and the
 * validation `details` tree when there is one. Views render `.message`, which
 * already ends in `(ref …)`, so the correlation id reaches the screen without
 * every view having to know about it.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly details?: unknown;
  constructor(message: string, status: number, requestId?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

/**
 * The one place a failed response becomes an Error — shared by both helpers, so
 * a JSON call and an upload report failures identically.
 */
async function throwForResponse(response: Response): Promise<never> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    ssoUrl?: string;
    details?: unknown;
  };
  const ref = requestId ? ` (ref ${requestId})` : "";

  // The console gets the parts the UI has no room for: the request that failed,
  // the validation tree, the correlation id. The fetch wrapper in log.ts logged
  // the status line already — this adds the body it cannot see.
  logError("api", `${response.status} ${response.url}`, {
    error: body.error,
    ...(requestId ? { requestId } : {}),
    ...(body.details === undefined ? {} : { details: body.details }),
  });

  if (response.status === 401) throw new UnauthenticatedError(body.ssoUrl ?? "");
  if (response.status === 403) throw new ForbiddenError(`${body.error ?? "Access denied"}${ref}`);
  throw new ApiError(
    `${body.error ?? `Request failed: ${response.status} ${response.statusText}`}${ref}`,
    response.status,
    requestId,
    body.details
  );
}

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) await throwForResponse(response);

  return response.json() as Promise<T>;
}

export async function requestFormData<T>(url: string, body: FormData): Promise<T> {
  const response = await fetch(url, {
    method: "POST", // no Content-Type — browser sets multipart boundary
    body,
  });

  if (!response.ok) await throwForResponse(response);

  return response.json() as Promise<T>;
}

export function getMe() {
  return request<{ user: PortalUser; isAdmin: boolean }>("/api/me");
}

export function setDevRole(role: "user" | "admin") {
  return request<{ ok: true; role: "user" | "admin" }>("/api/dev/role", {
    method: "POST",
    body: JSON.stringify({ role }),
  });
}

export function getPortalConfig() {
  return fetch("/api/config").then((r) => r.json() as Promise<PortalConfig>);
}
