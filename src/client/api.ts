import type { PortalUser } from "../server/types";

export type DemoUserRole = "regular" | "admin";

export type PortalConfig = {
  ssoRequired: boolean;
  ssoUrl: string;
  artifactoryEnabled: boolean;
  chatEnabled: boolean;
};

export const demoUsers: Record<DemoUserRole, { label: string; headers: Record<string, string> }> = {
  regular: {
    label: "Regular user",
    headers: {
      "x-user-id": "u-alex",
      "x-user-name": "Alex Morgan",
      "x-user-email": "alex@example.com",
      "x-user-groups": "team-alpha",
    },
  },
  admin: {
    label: "Admin user",
    headers: {
      "x-user-id": "u-admin",
      "x-user-name": "Morgan Admin",
      "x-user-email": "morgan.admin@example.com",
      "x-user-groups": "team-alpha,portal-admins",
    },
  },
};

const demoUserStorageKey = "devops-portal-demo-user";

export function getDemoUserRole(): DemoUserRole {
  const value = window.localStorage.getItem(demoUserStorageKey);
  return value === "admin" ? "admin" : "regular";
}

export function setDemoUserRole(role: DemoUserRole) {
  window.localStorage.setItem(demoUserStorageKey, role);
}

export function getDemoHeaders() {
  return demoUsers[getDemoUserRole()].headers;
}

export class UnauthenticatedError extends Error {
  readonly ssoUrl: string;
  constructor(ssoUrl: string) {
    super("Authentication required");
    this.name = "UnauthenticatedError";
    this.ssoUrl = ssoUrl;
  }
}

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...getDemoHeaders(),
      ...options?.headers,
    },
  });

  if (response.status === 401) {
    const body = await response.json().catch(() => ({}));
    throw new UnauthenticatedError(body.ssoUrl ?? "");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function requestFormData<T>(url: string, body: FormData): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: getDemoHeaders(), // no Content-Type — browser sets multipart boundary
    body,
  });

  if (response.status === 401) {
    const data = await response.json().catch(() => ({}));
    throw new UnauthenticatedError(data.ssoUrl ?? "");
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

export function getPortalConfig() {
  return fetch("/api/config").then((r) => r.json() as Promise<PortalConfig>);
}
