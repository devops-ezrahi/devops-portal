import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { config } from "../../config";
import { describeError, log } from "../../log";

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
export async function exists(path: string, signal?: AbortSignal): Promise<boolean | null> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${serviceUrl()}/${path}`, { method: "HEAD", headers: authHeaders(), signal });
  } catch (err) {
    // Aborting a job cancels these in flight; that is not a fault worth a line.
    if (!signal?.aborted) log.warn("artifactory", `HEAD ${path} could not be sent: ${describeError(err)}`);
    return null;
  }
  log.debug("artifactory", `HEAD ${path} ${res.status}`, { ms: Date.now() - started });
  if (res.ok) return true;
  if (res.status === 404) return false;
  // Neither present nor absent: 401/403 here is the token missing read access,
  // which without this line looks exactly like a repo full of new packages.
  log.warn("artifactory", `HEAD ${path} answered ${res.status} ${res.statusText} — treating existence as unknown`);
  return null;
}

/**
 * Every existing file under a repo-relative folder, in one request — replaces
 * what would otherwise be one `HEAD` per item, the same round-trip cost
 * whether checking 1 package or 1,000. `null` means the listing could not be
 * trusted (bad response, network error, unexpected shape); callers must fall
 * back to per-item `exists()` rather than treat `null` as "nothing exists".
 */
export async function listExisting(repoPath: string, signal?: AbortSignal): Promise<Set<string> | null> {
  const started = Date.now();
  const url = `${serviceUrl()}/api/storage/${repoPath}?list&deep=1&listFolders=0`;
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(), signal });
  } catch (err) {
    if (!signal?.aborted) {
      log.warn("artifactory", `listing ${repoPath} could not be sent: ${describeError(err)} — falling back to one HEAD per package`);
    }
    return null;
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim().slice(0, 300);
    log.warn(
      "artifactory",
      `listing ${repoPath} answered ${res.status} ${res.statusText} — falling back to one HEAD per package`,
      { detail: detail || undefined }
    );
    return null;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    log.warn("artifactory", `listing ${repoPath} returned non-JSON: ${describeError(err)}`);
    return null;
  }

  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) {
    log.warn("artifactory", `listing ${repoPath} had no "files" array — falling back to one HEAD per package`);
    return null;
  }

  log.info("artifactory", `listed ${files.length} existing file(s) under ${repoPath}`, { ms: Date.now() - started });
  const paths = new Set<string>();
  for (const entry of files) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { uri?: unknown }).uri === "string" &&
      (entry as { folder?: unknown }).folder !== true
    ) {
      paths.add(`${repoPath}${(entry as { uri: string }).uri}`);
    }
  }
  return paths;
}

/**
 * PUT a local file to a repo-relative path. Throws with Artifactory's own error
 * body. `signal` aborts the transfer itself: without it, stopping a job left a
 * multi-hundred-MB PUT streaming on from a temp dir the job was already
 * deleting.
 */
export async function upload(path: string, localFile: string, signal?: AbortSignal): Promise<void> {
  const { size } = await stat(localFile);
  const started = Date.now();
  log.debug("artifactory", `PUT ${path}`, { bytes: size, from: localFile });
  const res = await fetch(`${serviceUrl()}/${path}`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Length": String(size) },
    signal,
    body: Readable.toWeb(createReadStream(localFile)) as ReadableStream,
    // Node requires this for a streaming request body.
    duplex: "half",
  } as RequestInit);

  const ms = Date.now() - started;
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim();
    log.warn("artifactory", `PUT ${path} failed ${res.status} ${res.statusText}`, { ms, bytes: size, detail: detail.slice(0, 300) || undefined });
    throw new Error(`Artifactory responded ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  log.debug("artifactory", `PUT ${path} ${res.status}`, { ms, bytes: size });
}
