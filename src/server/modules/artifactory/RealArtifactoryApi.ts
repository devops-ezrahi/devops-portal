import { execFile } from "child_process";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { config } from "../../config";
import type { ArtifactoryApi, ArtifactoryJob, FolderUploadInput, PortalUser, UrlCopyInput } from "../../types";

const execFileAsync = promisify(execFile);

function nowIso() {
  return new Date().toISOString();
}

export class RealArtifactoryApi implements ArtifactoryApi {
  private jobs = new Map<string, ArtifactoryJob>();
  private counter = 0;

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
    job.log.push(line);
    job.updatedAt = nowIso();
  }

  private async jfUpload(jobId: string, src: string, target: string, extraArgs: string[] = []) {
    const { url, token } = config.artifactory;
    if (!url || !token) {
      throw new Error("ARTIFACTORY_URL and ARTIFACTORY_TOKEN must be set to use jf CLI");
    }

    const displayArgs = ["rt", "u", src, target, ...extraArgs];
    this.appendLog(jobId, `$ jf ${displayArgs.join(" ")}`);

    const cliArgs = [...displayArgs, "--url", url, "--access-token", token];

    try {
      const { stdout, stderr } = await execFileAsync("jf", cliArgs, {
        maxBuffer: 10 * 1024 * 1024,
      });
      const lines = `${stdout}\n${stderr}`.split("\n").filter(Boolean);
      for (const line of lines) this.appendLog(jobId, line);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      if (e.code === "ENOENT") {
        throw new Error("jf CLI not found — install JFrog CLI and ensure it is on PATH");
      }
      const detail = [e.stderr, e.stdout, e.message].find(Boolean) ?? "jf CLI command failed";
      throw new Error(detail.toString().trim());
    }
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
      folderName: input.folderName,
      fileCount: input.fileCount,
      totalBytes: input.totalBytes,
      log: [],
    };
    this.jobs.set(job.id, job);
    void this.runFolderUpload(job.id, input);
    return job;
  }

  async listJobs(user: PortalUser, allUsers = false): Promise<ArtifactoryJob[]> {
    return [...this.jobs.values()]
      .filter((j) => allUsers || j.submittedBy === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getJob(jobId: string): Promise<ArtifactoryJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  private async runUrlCopy(jobId: string, input: UrlCopyInput) {
    const tmpDir = join(tmpdir(), `art-url-copy-${randomUUID()}`);
    try {
      this.patch(jobId, { status: "in-progress" });
      this.appendLog(jobId, `Fetching ${input.sourceUrl} ...`);

      const res = await fetch(input.sourceUrl);
      if (!res.ok) {
        throw new Error(`Source responded with ${res.status} ${res.statusText}`);
      }

      const filename = new URL(input.sourceUrl).pathname.split("/").filter(Boolean).pop();
      if (!filename) throw new Error("Cannot determine filename from source URL");

      await mkdir(tmpDir, { recursive: true });
      const tmpFile = join(tmpDir, filename);
      await writeFile(tmpFile, Buffer.from(await res.arrayBuffer()));

      const target = `${config.artifactory.repo}/${filename}`;
      this.appendLog(jobId, `Uploading to ${target} via jf CLI ...`);

      await this.jfUpload(jobId, tmpFile, target);

      this.patch(jobId, { status: "completed" });
      this.appendLog(jobId, `Done. Artifact available at ${target}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.patch(jobId, { status: "failed", errorMessage: message });
      this.appendLog(jobId, `Error: ${message}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async runFolderUpload(jobId: string, input: FolderUploadInput) {
    const tmpDir = join(tmpdir(), `art-folder-${randomUUID()}`);
    try {
      this.patch(jobId, { status: "in-progress" });

      const files = input.files ?? [];
      if (files.length === 0) {
        throw new Error("No file data received — ensure the client sends actual files");
      }

      this.appendLog(jobId, `Writing ${files.length} file(s) to temp directory ...`);
      await mkdir(tmpDir, { recursive: true });

      for (const file of files) {
        const dest = join(tmpDir, file.originalname);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, file.buffer);
      }

      const target = `${config.artifactory.repo}/${input.folderName}/`;
      this.appendLog(jobId, `Uploading to ${target} via jf CLI ...`);

      await this.jfUpload(jobId, `${tmpDir}/`, target, ["--recursive", "--flat=false"]);

      this.patch(jobId, { status: "completed" });
      this.appendLog(jobId, `Done. ${files.length} file(s) deployed to ${target}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.patch(jobId, { status: "failed", errorMessage: message });
      this.appendLog(jobId, `Error: ${message}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}
