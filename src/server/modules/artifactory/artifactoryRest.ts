import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { config } from "../../config";
import { describeError, log } from "../../log";
import { sourceTokenFor } from "./npmDependencies";

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

/** One agent image: the name a stage's `image` argument takes, plus its labels. */
export type ImageInfo = { name: string; labels: Record<string, string> };

/**
 * Every image under a repo-relative path, with the Docker labels Artifactory
 * indexed off each manifest, in **one** request. AQL rather than
 * `api/storage?list` because the labels are properties on the manifest and a
 * listing does not carry properties — the alternative is one properties call
 * per image on top of the listing.
 *
 * Only `SCREAMING_CASE` labels are kept: those are the ones that describe the
 * image (`JDK=17`), while Docker's own conventional labels are lowercase and
 * dotted (`org.opencontainers.image.*`) and say nothing a user picking an image
 * needs. `null` means the call could not be trusted, never "no images".
 */
export async function listImages(repoPath: string): Promise<ImageInfo[] | null> {
  const started = Date.now();
  const [repo, ...rest] = repoPath.split("/").filter(Boolean);
  if (!repo) return null;
  const prefix = rest.join("/");
  // AQL's `*` crosses `/`, so this matches a manifest at any depth under the
  // configured path. Depth must stay open: the folder holding the names is the
  // repo root in one layout and an image whose tags are the names in another,
  // and the name is read back off the path either way.
  const pathMatch = prefix ? `${prefix}/*` : "*";
  const query =
    `items.find({"repo":${JSON.stringify(repo)},"path":{"$match":${JSON.stringify(pathMatch)}},` +
    `"name":"manifest.json"}).include("path","property.key","property.value")`;

  let res: Response;
  try {
    res = await fetch(`${serviceUrl()}/api/search/aql`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: query,
    });
  } catch (err) {
    log.warn("artifactory", `image search under ${repoPath} could not be sent: ${describeError(err)}`);
    return null;
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim().slice(0, 300);
    log.warn("artifactory", `image search under ${repoPath} answered ${res.status} ${res.statusText}`, {
      detail: detail || undefined,
    });
    return null;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    log.warn("artifactory", `image search under ${repoPath} returned non-JSON: ${describeError(err)}`);
    return null;
  }

  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    log.warn("artifactory", `image search under ${repoPath} had no "results" array`);
    return null;
  }

  // An image has one manifest per tag, so the same name arrives several times;
  // the labels are merged rather than the later row replacing the earlier one.
  const byName = new Map<string, Record<string, string>>();
  for (const row of results) {
    const path = (row as { path?: unknown })?.path;
    if (typeof path !== "string") continue;
    const name = path.slice(prefix ? prefix.length + 1 : 0).split("/")[0];
    if (!name) continue;
    const labels = byName.get(name) ?? {};
    for (const prop of ((row as { properties?: unknown }).properties as unknown[]) ?? []) {
      const key = (prop as { key?: unknown })?.key;
      const value = (prop as { value?: unknown })?.value;
      if (typeof key !== "string" || typeof value !== "string") continue;
      const label = key.startsWith("docker.label.") ? key.slice("docker.label.".length) : null;
      if (label && /^[A-Z][A-Z0-9_]*$/.test(label)) labels[label] = value;
    }
    byName.set(name, labels);
  }

  log.info("artifactory", `found ${byName.size} image(s) under ${repoPath}`, { ms: Date.now() - started });
  return [...byName].map(([name, labels]) => ({ name, labels })).sort((a, b) => a.name.localeCompare(b.name));
}

/** One file found under a folder URL: where to fetch it, and its repo-relative path. */
export type SourceFile = { url: string; repoPath: string };

/**
 * Every file under a pasted URL that names a **folder**, or `null` when it names
 * a file (which is the ordinary case, and what the caller falls back to).
 *
 * Artifactory serves a folder's bytes as an HTML browse page, so fetching a
 * folder URL "succeeds" and writes junk to disk — there is no status code that
 * says "that was a directory". `api/storage/<repo>/<path>?list` is the only
 * thing that answers the question: it lists a folder's children and refuses a
 * file, so a non-OK response *is* the "this is a file" signal. Deep, because a
 * package's files are not always in one directory — a Maven version folder is
 * flat but an npm scope folder is not.
 *
 * Only `/artifactory/<repo>/…` URLs are asked; a public mirror has no such API,
 * and a pasted file URL from one still works exactly as before.
 */
export async function listSourceFolder(sourceUrl: string, signal?: AbortSignal): Promise<SourceFile[] | null> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  // <repo> plus at least one path segment: a bare repo root is a listing nobody
  // means to copy, and `?list&deep=1` on one would walk the whole repository.
  if (segments[0] !== "artifactory" || segments.length < 3) return null;
  const repoPath = segments.slice(1).join("/");
  const token = sourceTokenFor(url.origin, config.artifactory.url, config.artifactory.token, "");

  let res: Response;
  try {
    res = await fetch(`${url.origin}/artifactory/api/storage/${repoPath}?list&deep=1&listFolders=0`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    });
  } catch (err) {
    if (!signal?.aborted) log.debug("artifactory", `folder listing for ${sourceUrl} could not be sent: ${describeError(err)}`);
    return null;
  }
  if (!res.ok) {
    log.debug("artifactory", `${sourceUrl} is not a folder (api/storage answered ${res.status})`);
    return null;
  }

  const body = await res.json().catch(() => null);
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return null;

  // The repo name is not part of a repo-relative path — `classify` reads the
  // Maven group off exactly these segments, so an extra leading folder would be
  // folded into the groupId.
  const insideRepo = segments.slice(2).join("/");
  return files.flatMap((entry) => {
    const uri = (entry as { uri?: unknown })?.uri;
    if (typeof uri !== "string" || (entry as { folder?: unknown }).folder === true) return [];
    const tail = uri.replace(/^\//, "");
    return [{
      url: `${url.origin}/artifactory/${repoPath}/${tail.split("/").map(encodeURIComponent).join("/")}`,
      repoPath: `${insideRepo}/${tail}`,
    }];
  });
}

/**
 * Auth for fetching a file *out of* a source repository. Same rule as the
 * dependency resolvers use: a source on the same host as `ARTIFACTORY_URL` is
 * ours, so it reuses `ARTIFACTORY_TOKEN`; anything else is anonymous, which is
 * how the single-file URL copy has always fetched.
 */
export function sourceHeaders(sourceUrl: string): Record<string, string> {
  let origin: string;
  try {
    origin = new URL(sourceUrl).origin;
  } catch {
    return {};
  }
  const token = sourceTokenFor(origin, config.artifactory.url, config.artifactory.token, "");
  return token ? { Authorization: `Bearer ${token}` } : {};
}
