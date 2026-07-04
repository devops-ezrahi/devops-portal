import type { PortalUser } from "../server/types";

export type PortalConfig = {
  ssoRequired: boolean;
  ssoUrl: string;
  artifactoryEnabled: boolean;
  chatEnabled: boolean;
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

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (response.status === 401) {
    const body = await response.json().catch(() => ({}));
    throw new UnauthenticatedError(body.ssoUrl ?? "");
  }

  if (response.status === 403) {
    const body = await response.json().catch(() => ({}));
    throw new ForbiddenError(body.error ?? "Access denied");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function requestFormData<T>(url: string, body: FormData): Promise<T> {
  const response = await fetch(url, {
    method: "POST", // no Content-Type — browser sets multipart boundary
    body,
  });

  if (response.status === 401) {
    const data = await response.json().catch(() => ({}));
    throw new UnauthenticatedError(data.ssoUrl ?? "");
  }

  if (response.status === 403) {
    const data = await response.json().catch(() => ({}));
    throw new ForbiddenError(data.error ?? "Access denied");
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `Request failed: ${response.status}`);
  }

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
