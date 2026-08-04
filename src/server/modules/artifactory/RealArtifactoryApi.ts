import { execFile } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
// Rejects on abort, so a cancelled simulation stops mid-sleep instead of at the
// end of the current beat.
import { setTimeout as sleep } from "timers/promises";
import { promisify } from "util";
import { config } from "../../config";
import { redactSecrets } from "../../redact";
import { createTmpDir, removeTmpDir } from "../../tmp";
import { exists, upload, webUrl } from "./artifactoryRest";
import { artifactorySimulation, simulatedArtifactoryJob } from "./devSimulation";
import { discoverPackages, jobName, packAndUpload, pool, targetPath } from "./npmPackages";
import type {
  ArtifactoryApi,
  ArtifactoryJob,
  FolderUploadInput,
  PackageUploadResult,
  PortalUser,
  UploadedFile,
  UrlCopyInput,
} from "../../types";

const execFileAsync = promisify(execFile);

/** Raw-tree fallback for folders that contain no npm packages at all. */
const RAW_UPLOAD_CONCURRENCY = 8;

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

  async simulate(submitter: PortalUser): Promise<ArtifactoryJob> {
    const job: ArtifactoryJob = {
      id: this.newId(),
      kind: "folder-upload",
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      log: [],
      ...simulatedArtifactoryJob(),
    };
    this.jobs.set(job.id, job);
    void this.runSimulation(job.id);
    return job;
  }

  private async runSimulation(jobId: string) {
    const signal = this.start(jobId);
    try {
      for (const beat of artifactorySimulation) {
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
      resultUrl:
        results.length === 1 ? results[0].url : webUrl(config.artifactory.repo),
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

      const identity = await readTarballIdentity(tmpFile);
      const target = identity
        ? targetPath(identity.name, identity.version)
        : `${config.artifactory.repo}/${filename}`;

      if (identity) {
        this.patch(jobId, { name: `${identity.name}@${identity.version}` });
      } else {
        this.appendLog(jobId, "Not an npm tarball — uploading under its own filename.");
        this.patch(jobId, { name: filename });
      }

      if ((await exists(target)) === true) {
        this.appendLog(jobId, `${target} already exists — skipping upload.`);
        this.patch(jobId, { status: "completed", resultUrl: webUrl(target) });
        return;
      }

      this.appendLog(jobId, `Uploading to ${target} ...`);
      await upload(target, tmpFile);

      this.patch(jobId, { status: "completed", resultUrl: webUrl(target) });
      this.appendLog(jobId, `Done. Artifact available at ${target}.`);
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
      if (files.length === 0) {
        throw new Error("No file data received — ensure the client sends actual files");
      }

      this.appendLog(jobId, `Writing ${files.length} file(s) to temp directory ...`);
      const sourceDir = join(tmpDir, "source");
      for (const file of files) {
        const dest = join(sourceDir, safeRelativePath(file.originalname));
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, file.buffer);
      }

      const packages = await discoverPackages(sourceDir, (line) => this.appendLog(jobId, line));

      if (packages.length === 0) {
        this.appendLog(jobId, "No npm packages found — uploading the folder as-is.");
        await this.uploadRawTree(jobId, sourceDir, files, input.folderName, signal);
        return;
      }

      this.patch(jobId, { name: jobName(packages, input.folderName) });
      this.appendLog(jobId, `Found ${packages.length} package(s).`);

      const results = await packAndUpload(
        packages,
        join(tmpDir, "stage"),
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

  /** Preserves the old behaviour for folders that aren't npm packages. */
  private async uploadRawTree(
    jobId: string,
    sourceDir: string,
    files: UploadedFile[],
    folderName: string,
    signal?: AbortSignal
  ) {
    const prefix = `${config.artifactory.repo}/${safeRelativePath(folderName)}`;
    const paths = files.map((f) => safeRelativePath(f.originalname));
    let done = 0;
    const failures: string[] = [];

    this.patch(jobId, { progress: { done: 0, total: paths.length } });

    await pool(paths, RAW_UPLOAD_CONCURRENCY, async (relative) => {
      if (signal?.aborted) return;
      const target = `${prefix}/${relative}`;
      try {
        if ((await exists(target)) !== true) await upload(target, join(sourceDir, relative));
      } catch (err) {
        failures.push(`${relative}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.patch(jobId, { progress: { done: ++done, total: paths.length } });
      }
    });

    if (this.aborted(jobId)) return;
    for (const failure of failures) this.appendLog(jobId, `Failed ${failure}`);

    this.patch(jobId, {
      status: failures.length > 0 ? "failed" : "completed",
      errorMessage: failures.length > 0 ? `${failures.length} of ${paths.length} file(s) failed` : undefined,
      resultUrl: webUrl(prefix),
    });
    this.appendLog(jobId, `Done. ${paths.length - failures.length} file(s) deployed to ${prefix}/.`);
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
