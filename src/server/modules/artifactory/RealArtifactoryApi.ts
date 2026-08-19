import { execFile } from "child_process";
import { mkdir, readdir, writeFile } from "fs/promises";
import { basename, dirname, join, relative } from "path";
// Rejects on abort, so a cancelled simulation stops mid-sleep instead of at the
// end of the current beat.
import { setTimeout as sleep } from "timers/promises";
import { promisify } from "util";
import { config } from "../../config";
import { redactSecrets } from "../../redact";
import { createTmpDir, removeTmpDir } from "../../tmp";
import { webUrl } from "./artifactoryRest";
import { artifactorySimulation, simulatedArtifactoryJob } from "./devSimulation";
import { discoverPackages, jobName, npmUploadItems, pool, targetPath, uploadFiles } from "./npmPackages";
import { classify, urlArtifactPath } from "./packageTypes";
import type { UploadItem } from "./npmPackages";
import type {
  ArtifactoryApi,
  ArtifactoryJob,
  ArtifactoryScenario,
  FolderUploadInput,
  PackageUploadResult,
  PortalUser,
  UrlCopyInput,
} from "../../types";

const execFileAsync = promisify(execFile);

/**
 * Staging the upload to disk is IO-bound, not CPU-bound, so overlapping it wins
 * a lot on a big node_modules. Kept well under the default file-descriptor
 * limit — every worker holds one open write at a time.
 *
 * ponytail: a flat constant, not a measured optimum. Raise it if staging is
 * still the slow part on the real hardware.
 */
const TEMP_WRITE_CONCURRENCY = 16;

function nowIso() {
  return new Date().toISOString();
}

/**
 * `originalname` is the browser-supplied relative path. It is joined onto a temp
 * dir and then onto the Artifactory target, so a `..` segment would write and
 * publish outside both.
 */
function safeRelativePath(name: string): string {
  const normalised = name.replace(/\\/g, "/");
  const segments = normalised.split("/").filter(Boolean);
  if (
    normalised.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalised) ||
    segments.some((s) => s === ".." || s === ".")
  ) {
    throw new Error(`Rejected unsafe path in upload: ${name}`);
  }
  return segments.join("/");
}

/** Every file under `root`, as forward-slash paths relative to `root`. */
async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(root, full).replace(/\\/g, "/"));
    }
  }
  await walk(root);
  return out;
}

export class RealArtifactoryApi implements ArtifactoryApi {
  private jobs = new Map<string, ArtifactoryJob>();
  private counter = 0;
  /** One per running job, so `cancelJob` can stop the work already in flight. */
  private controllers = new Map<string, AbortController>();

  private newId() {
    return `ART-${String(++this.counter).padStart(4, "0")}`;
  }

  private patch(jobId: string, updates: Partial<ArtifactoryJob>) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, { ...updates, updatedAt: nowIso() });
  }

  private appendLog(jobId: string, line: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.log.push(redactSecrets(line));
    job.updatedAt = nowIso();
  }

  /**
   * True once the user has stopped the job. Every run's `catch` and `finish`
   * consults it: the AbortError the cancel *caused* must not relabel an
   * aborted job as failed.
   */
  private aborted(jobId: string): boolean {
    return this.jobs.get(jobId)?.status === "aborted";
  }

  private start(jobId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    return controller.signal;
  }

  async submitUrlCopy(input: UrlCopyInput, submitter: PortalUser): Promise<ArtifactoryJob> {
    const job: ArtifactoryJob = {
      id: this.newId(),
      kind: "url-copy",
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      sourceUrl: input.sourceUrl,
      log: [],
    };
    this.jobs.set(job.id, job);
    void this.runUrlCopy(job.id, input);
    return job;
  }

  async submitFolderUpload(input: FolderUploadInput, submitter: PortalUser): Promise<ArtifactoryJob> {
    const job: ArtifactoryJob = {
      id: this.newId(),
      kind: "folder-upload",
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      name: input.folderName,
      folderName: input.folderName,
      fileCount: input.fileCount,
      totalBytes: input.totalBytes,
      log: [],
    };
    this.jobs.set(job.id, job);
    void this.runFolderUpload(job.id, input);
    return job;
  }

  async simulate(submitter: PortalUser, scenario: ArtifactoryScenario = "npm"): Promise<ArtifactoryJob> {
    const job: ArtifactoryJob = {
      id: this.newId(),
      kind: "folder-upload",
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      log: [],
      ...simulatedArtifactoryJob(scenario),
    };
    this.jobs.set(job.id, job);
    void this.runSimulation(job.id, scenario);
    return job;
  }

  private async runSimulation(jobId: string, scenario: ArtifactoryScenario) {
    const signal = this.start(jobId);
    try {
      for (const beat of artifactorySimulation(scenario)) {
        await sleep(beat.ms, undefined, { signal });
        if (beat.patch) this.patch(jobId, beat.patch);
        if (beat.line) this.appendLog(jobId, beat.line);
      }
    } catch {
      // Only sleep() rejects here, and only because the job was cancelled.
    } finally {
      this.controllers.delete(jobId);
    }
  }

  async listJobs(user: PortalUser, allUsers = false): Promise<ArtifactoryJob[]> {
    return [...this.jobs.values()]
      .filter((j) => allUsers || j.submittedBy === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getJob(jobId: string): Promise<ArtifactoryJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async cancelJob(jobId: string, user: PortalUser, allUsers = false): Promise<ArtifactoryJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (!allUsers && job.submittedBy !== user.id) {
      throw new Error("Forbidden: not your job");
    }
    // Finished is finished — a late Stop must not rewrite history.
    if (job.status !== "pending" && job.status !== "in-progress") return job;

    this.patch(jobId, { status: "aborted", errorMessage: undefined });
    this.appendLog(jobId, `Aborted by ${user.displayName}.`);
    this.controllers.get(jobId)?.abort();
    return job;
  }

  /** Job is failed if anything failed, but the successes are still reported. */
  private finish(jobId: string, results: PackageUploadResult[]) {
    if (this.aborted(jobId)) return;
    const failures = results.filter((r) => r.status === "failed");
    const uploaded = results.filter((r) => r.status === "uploaded").length;
    const skipped = results.filter((r) => r.status === "exists").length;

    this.patch(jobId, {
      packages: results,
      status: failures.length > 0 ? "failed" : "completed",
      errorMessage:
        failures.length > 0 ? `${failures.length} of ${results.length} package(s) failed` : undefined,
      // For many packages, link the repo they went to — which is no longer always
      // the npm one, so take it from the first target rather than from config.
      resultUrl:
        results.length === 1
          ? results[0].url
          : webUrl(results[0]?.path.split("/")[0] ?? config.artifactory.repo),
    });
    this.appendLog(
      jobId,
      `Done. ${uploaded} uploaded, ${skipped} already present, ${failures.length} failed.`
    );
  }

  private async runUrlCopy(jobId: string, input: UrlCopyInput) {
    const signal = this.start(jobId);
    const tmpDir = await createTmpDir("art-");
    try {
      this.patch(jobId, { status: "in-progress" });
      this.appendLog(jobId, `Fetching ${input.sourceUrl} ...`);

      const res = await fetch(input.sourceUrl, { signal });
      if (!res.ok) {
        throw new Error(`Source responded with ${res.status} ${res.statusText}`);
      }

      const filename = new URL(input.sourceUrl).pathname.split("/").filter(Boolean).pop();
      if (!filename) throw new Error("Cannot determine filename from source URL");

      const tmpFile = join(tmpDir, safeRelativePath(filename));
      await writeFile(tmpFile, Buffer.from(await res.arrayBuffer()));

      // The npm sniff reads the file itself, so it wins over any path guess.
      const identity = await readTarballIdentity(tmpFile);
      const classified = identity
        ? null
        : classify(urlArtifactPath(input.sourceUrl), (line) => this.appendLog(jobId, line));

      let item: UploadItem;
      if (identity) {
        item = {
          path: targetPath(identity.name, identity.version),
          name: identity.name,
          version: identity.version,
          type: "npm",
          resolve: async () => tmpFile,
        };
        this.patch(jobId, { name: `${identity.name}@${identity.version}` });
      } else if (classified) {
        item = { ...classified, resolve: async () => tmpFile };
        this.appendLog(jobId, `Detected a ${classified.type} artifact.`);
        this.patch(jobId, { name: `${classified.name}@${classified.version}` });
      } else {
        item = {
          path: `${config.artifactory.repo}/${filename}`,
          name: filename,
          version: "",
          type: "npm",
          resolve: async () => tmpFile,
        };
        this.appendLog(jobId, "Unrecognised artifact — uploading under its own filename.");
        this.patch(jobId, { name: filename });
      }

      // Same uploadFiles/finish path as a folder upload, so a URL copy fills in
      // `packages` and `progress` too — which is what makes the package table
      // (and its direct link) and the progress bar render for it at all.
      const results = await uploadFiles(
        [item],
        (line) => this.appendLog(jobId, line),
        (done, total) => this.patch(jobId, { progress: { done, total } }),
        signal
      );

      this.finish(jobId, results);
    } catch (err) {
      if (this.aborted(jobId)) return;
      const message = err instanceof Error ? err.message : String(err);
      this.patch(jobId, { status: "failed", errorMessage: message });
      this.appendLog(jobId, `Error: ${message}`);
    } finally {
      await removeTmpDir(tmpDir, (line) => this.appendLog(jobId, line));
      this.controllers.delete(jobId);
    }
  }

  private async runFolderUpload(jobId: string, input: FolderUploadInput) {
    const signal = this.start(jobId);
    const tmpDir = await createTmpDir("art-");
    try {
      this.patch(jobId, { status: "in-progress" });

      const files = input.files ?? [];
      if (files.length === 0 && !input.archive) {
        throw new Error("No file data received — ensure the client sends actual files");
      }

      const sourceDir = join(tmpDir, "source");
      let relPaths: string[];
      if (input.archive) {
        // One compressed blob + one native unzip beats tens of thousands of
        // uncompressed multipart parts and as many individual fs writes — this
        // is the whole reason a folder drop used to be ~100x slower than
        // dragging a hand-made zip of the same folder.
        this.appendLog(jobId, "Extracting uploaded archive ...");
        await mkdir(sourceDir, { recursive: true });
        const zipPath = join(tmpDir, "upload.zip");
        await writeFile(zipPath, input.archive);
        try {
          await execFileAsync("unzip", ["-q", "upload.zip", "-d", "source"], { cwd: tmpDir });
        } catch (err) {
          // unzip exits 1 for "extracted, with warnings" (e.g. a Windows-built
          // zip warning about backslash separators) and only >= 2 for a real
          // failure — see RealWhiteningApi.submitUnpack for the same handling.
          const code = (err as { code?: number }).code;
          if (code !== 1) {
            throw new Error("Could not extract the uploaded folder archive");
          }
        }
        relPaths = await listFilesRecursive(sourceDir);
      } else {
        this.appendLog(jobId, `Writing ${files.length} file(s) to temp directory ...`);
        // Pooled rather than a plain for-await: a dropped node_modules is tens of
        // thousands of files, and one serialized mkdir+writeFile round trip each
        // was the bulk of the wait before any upload had started.
        await pool(files, TEMP_WRITE_CONCURRENCY, async (file) => {
          const dest = join(sourceDir, safeRelativePath(file.originalname));
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, file.buffer);
        });
        relPaths = files.map((f) => safeRelativePath(f.originalname));
      }

      const log = (line: string) => this.appendLog(jobId, line);
      const packages = await discoverPackages(sourceDir, log);

      // A file inside a discovered npm package ships in that package's tarball —
      // a .jar under node_modules/foo/ is not a Maven dependency.
      const packageDirs = packages
        .map((p) => relative(sourceDir, p.dir).replace(/\\/g, "/"))
        .filter(Boolean);
      const loose = relPaths.filter(
        (p) => !packageDirs.some((d) => p === d || p.startsWith(`${d}/`))
      );

      const items: UploadItem[] = npmUploadItems(packages, join(tmpDir, "stage"));
      let unrecognised = 0;
      for (const path of loose) {
        const found = classify(path, log);
        if (found) {
          // Already a finished artifact — nothing to pack, upload it as it is.
          items.push({ ...found, resolve: async () => join(sourceDir, path) });
          continue;
        }
        // classify() deliberately leaves .tgz alone: the filename can't give the
        // scope (@babel/core ships as core-7.0.0.tgz), so the manifest inside
        // decides. Without this a folder of loose tarballs looks unrecognised.
        const identity = path.toLowerCase().endsWith(".tgz")
          ? await readTarballIdentity(join(sourceDir, path))
          : null;
        if (identity) {
          items.push({
            path: targetPath(identity.name, identity.version),
            name: identity.name,
            version: identity.version,
            type: "npm",
            resolve: async () => join(sourceDir, path),
          });
          continue;
        }
        unrecognised++;
      }

      if (items.length === 0) {
        // Uploading the tree verbatim used to be the fallback here, which
        // quietly published a junk folder into the npm repo under its own name.
        // Failing is the honest answer: nothing in the drop was a package.
        throw new Error(
          `No recognised packages in ${input.folderName} — ` +
            `${loose.length} file(s) matched no known package type. Nothing was uploaded.`
        );
      }

      this.patch(jobId, { name: jobName(packages, input.folderName) });
      const counts = new Map<string, number>();
      for (const item of items) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
      this.appendLog(
        jobId,
        `Found ${[...counts].map(([type, n]) => `${n} ${type}`).join(", ")} package(s).`
      );
      if (unrecognised > 0) {
        this.appendLog(jobId, `${unrecognised} unrecognised file(s) skipped.`);
      }

      const results = await uploadFiles(
        items,
        log,
        (done, total) => this.patch(jobId, { progress: { done, total } }),
        signal
      );

      this.finish(jobId, results);
    } catch (err) {
      if (this.aborted(jobId)) return;
      const message = err instanceof Error ? err.message : String(err);
      this.patch(jobId, { status: "failed", errorMessage: message });
      this.appendLog(jobId, `Error: ${message}`);
    } finally {
      await removeTmpDir(tmpDir, (line) => this.appendLog(jobId, line));
      this.controllers.delete(jobId);
    }
  }

}

/**
 * Read `package/package.json` straight out of a tarball to get its real identity —
 * the filename alone cannot tell you the scope (`@babel/core` ships as
 * `core-7.0.0.tgz`). Returns null for anything that isn't an npm tarball.
 */
async function readTarballIdentity(file: string): Promise<{ name: string; version: string } | null> {
  try {
    // Relative to cwd — GNU tar treats a `C:` prefix as a remote host spec.
    const { stdout } = await execFileAsync("tar", ["-xzOf", basename(file), "package/package.json"], {
      cwd: dirname(file),
      maxBuffer: 4 * 1024 * 1024,
    });
    const manifest = JSON.parse(stdout);
    if (typeof manifest.name === "string" && typeof manifest.version === "string") {
      return { name: manifest.name, version: manifest.version };
    }
  } catch {
    // Not a tarball, no manifest inside it, or no tar on PATH — fall back to the
    // flat upload path rather than failing the whole job.
  }
  return null;
}
