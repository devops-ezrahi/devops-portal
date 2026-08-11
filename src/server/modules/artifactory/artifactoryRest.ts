import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { config } from "../../config";

/**
 * Artifactory wants the service URL (https://host/artifactory), not the JFrog
 * platform base URL — otherwise every request lands a path segment too high and
 * Artifactory answers with its own 404 page.
 */
export function serviceUrl(): string {
  const { url, token } = config.artifactory;
  if (!url || !token) {
    throw new Error("ARTIFACTORY_URL and ARTIFACTORY_TOKEN must be set to upload artifacts");
  }
  const trimmed = url.replace(/\/+$/, "");
  return /\/artifactory(\/|$)/.test(trimmed) ? trimmed : `${trimmed}/artifactory`;
}

function uiBase(): string {
  return config.artifactory.url.replace(/\/+$/, "").replace(/\/artifactory$/, "");
}

/** Repo tree browser link for a repo-relative path: `<base>/ui/repos/tree/General/<path>`. */
export function webUrl(path: string): string {
  return `${uiBase()}/ui/repos/tree/General/${path}`;
}

/** Native package view link for a repo-relative path: `<base>/ui/native/<path>`. */
export function nativeUrl(path: string): string {
  return `${uiBase()}/ui/native/${path}`;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${config.artifactory.token}` };
}

/**
 * `true` = present, `false` = absent, `null` = could not tell (auth or network).
 * Unknown must stay distinct from absent: a repo we can write but not read would
 * otherwise report every package as already uploaded and silently skip the job.
 */
export async function exists(path: string): Promise<boolean | null> {
  let res: Response;
  try {
    res = await fetch(`${serviceUrl()}/${path}`, { method: "HEAD", headers: authHeaders() });
  } catch {
    return null;
  }
  if (res.ok) return true;
  if (res.status === 404) return false;
  return null;
}

/** PUT a local file to a repo-relative path. Throws with Artifactory's own error body. */
export async function upload(path: string, localFile: string): Promise<void> {
  const { size } = await stat(localFile);
  const res = await fetch(`${serviceUrl()}/${path}`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Length": String(size) },
    body: Readable.toWeb(createReadStream(localFile)) as ReadableStream,
    // Node requires this for a streaming request body.
    duplex: "half",
  } as RequestInit);

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim();
    throw new Error(`Artifactory responded ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
}
