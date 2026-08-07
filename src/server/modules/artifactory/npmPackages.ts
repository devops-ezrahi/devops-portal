import { execFile } from "child_process";
import { cp, mkdir, readFile, readdir } from "fs/promises";
import { basename, join } from "path";
import { promisify } from "util";
import { config } from "../../config";
import type { PackageType, PackageUploadResult } from "../../types";
import { exists, upload, webUrl } from "./artifactoryRest";

const execFileAsync = promisify(execFile);

/** HEAD is cheap; uploads are not. */
const EXISTS_CONCURRENCY = 16;
const UPLOAD_CONCURRENCY = 4;

export type DiscoveredPackage = {
  dir: string;
  name: string;
  version: string;
};

/**
 * Run `fn` over `items` with at most `limit` in flight. Every worker pulls from
 * one shared iterator, so a slow item never blocks the others.
 */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const iterator = items[Symbol.iterator]();
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (const item of iterator) await fn(item);
  });
  await Promise.all(workers);
}

/**
 * Repo-relative npm registry path. The filename drops the scope — `@babel/core`
 * publishes as `@babel/core/-/core-7.0.0.tgz`, not `.../@babel/core-7.0.0.tgz`.
 */
export function targetPath(name: string, version: string): string {
  const filename = `${name.split("/").pop()}-${version}.tgz`;
  return `${config.artifactory.repo}/${name}/-/${filename}`;
}

/**
 * Every directory under `root` holding a usable package.json. One recursive walk
 * covers all the shapes a user can drop: a bare node_modules, a single package,
 * scoped `@scope/name`, and nested `node_modules/a/node_modules/b`.
 */
export async function discoverPackages(
  root: string,
  onSkip: (message: string) => void = () => {}
): Promise<DiscoveredPackage[]> {
  const found: DiscoveredPackage[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((e) => e.isFile() && e.name === "package.json")) {
      const manifestPath = join(dir, "package.json");
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (typeof manifest.name === "string" && typeof manifest.version === "string") {
          found.push({ dir, name: manifest.name, version: manifest.version });
        } else {
          onSkip(`Skipping ${basename(dir)}: package.json has no name/version.`);
        }
      } catch (err) {
        onSkip(`Skipping ${basename(dir)}: unreadable package.json (${err instanceof Error ? err.message : String(err)}).`);
      }
    }

    // Recurse regardless — a package can contain nested node_modules, and a
    // node_modules root has no package.json of its own.
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(join(dir, entry.name));
    }
  }

  await walk(root);
  return found;
}

/**
 * Build `<name>-<version>.tgz` with the `package/` prefix npm expects.
 *
 * Staged via a copy into a directory literally named `package` so the system tar
 * produces the right member paths — GNU tar's `--transform` and bsdtar's `-s`
 * are spelled differently, and the copy costs less than straddling both.
 * Nested node_modules is filtered out, matching what `npm pack` publishes.
 *
 * ponytail: copy-then-tar is O(size) extra I/O per package; switch to a
 * tar-library stream if packing a large node_modules ever gets too slow.
 */
async function packPackage(pkg: DiscoveredPackage, stageRoot: string, index: number): Promise<string> {
  const stage = join(stageRoot, String(index));
  await mkdir(stage, { recursive: true });
  await cp(pkg.dir, join(stage, "package"), {
    recursive: true,
    filter: (src) => basename(src) !== "node_modules",
  });

  const filename = `${pkg.name.split("/").pop()}-${pkg.version}.tgz`;
  const tgz = join(stage, filename);
  try {
    // Relative paths run from `cwd`, never absolute ones: GNU tar reads a leading
    // `C:` as a remote host spec and fails with "Cannot connect to C:".
    await execFileAsync("tar", ["-czf", filename, "package"], {
      cwd: stage,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new Error("tar not found — ensure it is on PATH");
    throw new Error((e.stderr || e.message || "tar failed").toString().trim());
  }
  return tgz;
}

export type UploadItem = {
  /** Repo-relative target, repo prefix included. */
  path: string;
  name: string;
  version: string;
  type: PackageType;
  /** The local file to PUT. Only called once the target is known to be absent. */
  resolve: () => Promise<string>;
};

/**
 * Upload every item the repo does not already have. Shared by all package types:
 * npm resolves to a freshly packed tarball, everything else to the file the user
 * already gave us.
 *
 * ponytail: `signal` is checked per item, so cancelling lets the one PUT already
 * in flight finish. Thread it into `artifactoryRest.upload` if that ever matters.
 */
export async function uploadFiles(
  items: UploadItem[],
  onLog: (line: string) => void,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<PackageUploadResult[]> {
  // Nested node_modules legitimately holds the same name@version more than once.
  const unique = [...new Map(items.map((item) => [item.path, item])).values()];

  const results: PackageUploadResult[] = unique.map((item) => ({
    name: item.name,
    version: item.version,
    path: item.path,
    type: item.type,
    status: "failed",
    error: "not processed",
  }));

  onLog(`Checking ${unique.length} package(s) against Artifactory ...`);

  const todo: { item: UploadItem; result: PackageUploadResult }[] = [];
  await pool(
    unique.map((item, index) => ({ item, index })),
    EXISTS_CONCURRENCY,
    async ({ item, index }) => {
      if (signal?.aborted) return;
      const result = results[index];
      const present = await exists(result.path);
      if (present === true) {
        result.status = "exists";
        delete result.error;
        result.url = webUrl(result.path);
      } else {
        // `null` means we could not tell — upload rather than silently skip.
        todo.push({ item, result });
      }
    }
  );

  const skipped = unique.length - todo.length;
  if (skipped > 0) onLog(`${skipped} package(s) already in the repo — skipping.`);

  let done = skipped;
  onProgress(done, unique.length);

  await pool(todo, UPLOAD_CONCURRENCY, async ({ item, result }) => {
    if (signal?.aborted) return;
    try {
      await upload(result.path, await item.resolve());
      result.status = "uploaded";
      delete result.error;
      result.url = webUrl(result.path);
      onLog(`Uploaded ${result.name}@${result.version}`);
    } catch (err) {
      result.status = "failed";
      result.error = err instanceof Error ? err.message : String(err);
      onLog(`Failed ${result.name}@${result.version}: ${result.error}`);
    } finally {
      onProgress(++done, unique.length);
    }
  });

  return results;
}

/** npm items for `uploadFiles` — packing is deferred until the upload is needed. */
export function npmUploadItems(packages: DiscoveredPackage[], stageRoot: string): UploadItem[] {
  return packages.map((pkg, index) => ({
    path: targetPath(pkg.name, pkg.version),
    name: pkg.name,
    version: pkg.version,
    type: "npm" as const,
    resolve: () => packPackage(pkg, stageRoot, index),
  }));
}

/**
 * Pack and upload every discovered package to the npm registry layout, skipping
 * what the repo already has. Shared by the Artifactory upload module and
 * Whitening's dependency step.
 */
export async function packAndUpload(
  packages: DiscoveredPackage[],
  stageRoot: string,
  onLog: (line: string) => void,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<PackageUploadResult[]> {
  return uploadFiles(npmUploadItems(packages, stageRoot), onLog, onProgress, signal);
}

/** `arg@4.1.5` for one package, `node_modules (142 packages)` for many. */
export function jobName(packages: DiscoveredPackage[], fallback: string): string {
  if (packages.length === 0) return fallback;
  if (packages.length === 1) return `${packages[0].name}@${packages[0].version}`;
  return `${fallback} (${packages.length} packages)`;
}
