import { execFile } from "child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { config } from "../../config";
import { jfUpload } from "../artifactory/jfUpload";
import { GiteaApi } from "./GiteaApi";
import type { PortalUser, WhiteningApi, WhiteningJob } from "../../types";

const execFileAsync = promisify(execFile);

function nowIso() {
  return new Date().toISOString();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export type PackConfig = {
  project: string;
  version: string;
  department: string;
  team: string;
  /** Repo name on the closed-network git — may differ from the project name. */
  repository: string;
};

// repository/config.json inside the .tgz; the packer writes it, filling
// department/team/repository from the CI job that ran it (see
// "whitening packer"/pack.py build_pack_config).
export function parsePackConfig(text: string): PackConfig {
  let raw: { version?: string; repos?: Record<string, Partial<PackConfig>> };
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("config.json in the archive is not valid JSON");
  }
  // One pack, one repo — take the first entry; its key is the project name.
  const [project, entry] = Object.entries(raw.repos ?? {})[0] ?? [];
  if (!project || !entry) {
    throw new Error("config.json must name the project under repos");
  }
  const { version } = raw;
  const { department, team, repository } = entry;
  if (!version || !department || !team || !repository) {
    throw new Error("config.json must set version, department, team and repository");
  }
  return { project, version, department, team, repository };
}

export class RealWhiteningApi implements WhiteningApi {
  private jobs = new Map<string, WhiteningJob>();
  private counter = 0;
  private gitea = new GiteaApi(config.git);

  private newId() {
    return `WHT-${String(++this.counter).padStart(4, "0")}`;
  }

  private patch(jobId: string, updates: Partial<WhiteningJob>) {
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

  async submitUnpack(archive: Buffer, archiveName: string, submitter: PortalUser): Promise<WhiteningJob> {
    // Extracted here rather than in run(): a bad archive must fail the request
    // (400) instead of a job. run() takes over the workDir and cleans it up.
    const workDir = join(tmpdir(), `whitening-${randomUUID()}`);
    const extractDir = join(workDir, "extracted");
    let packConfig: PackConfig;
    try {
      await mkdir(extractDir, { recursive: true });
      const archivePath = join(workDir, "pack.tgz");
      await writeFile(archivePath, archive);
      try {
        // tar ships with Linux and Windows 10+ — no unpacking library needed.
        await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir]);
      } catch {
        throw new Error(`Could not extract ${archiveName} — expected a .tgz from the whitening packer`);
      }
      const configPath = join(extractDir, "repository", "config.json");
      if (!(await pathExists(configPath))) {
        throw new Error("Archive is missing repository/config.json — repack it with a current whitening packer");
      }
      packConfig = parsePackConfig(await readFile(configPath, "utf8"));
    } catch (err) {
      await rm(workDir, { recursive: true, force: true });
      throw err;
    }

    const { department, team, project, version } = packConfig;
    const job: WhiteningJob = {
      id: this.newId(),
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      archiveName,
      department,
      team,
      project,
      version,
      log: [],
    };
    this.jobs.set(job.id, job);
    void this.run(job.id, workDir, extractDir, packConfig);
    return job;
  }

  async listJobs(user: PortalUser, allUsers = false): Promise<WhiteningJob[]> {
    return [...this.jobs.values()]
      .filter((j) => allUsers || j.submittedBy === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getJob(jobId: string): Promise<WhiteningJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  private async runCli(jobId: string, bin: string, args: string[], cwd?: string) {
    this.appendLog(jobId, `$ ${bin} ${args.join(" ")}`);
    try {
      const result = await execFileAsync(bin, args, { cwd, maxBuffer: 20 * 1024 * 1024 });
      const lines = `${result.stdout}\n${result.stderr}`.split("\n").filter(Boolean);
      for (const line of lines) this.appendLog(jobId, line);
      return result;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      if (e.code === "ENOENT") {
        throw new Error(`${bin} not found — ensure it is on PATH`);
      }
      const detail = [e.stderr, e.stdout, e.message].find(Boolean) ?? `${bin} command failed`;
      throw new Error(detail.toString().trim());
    }
  }

  private async run(jobId: string, workDir: string, extractDir: string, packConfig: PackConfig) {
    const job = this.jobs.get(jobId)!;
    try {
      this.patch(jobId, { status: "in-progress" });
      if (!config.git.enabled) {
        throw new Error("GIT_URL and GIT_TOKEN must be set to open pull requests");
      }

      await this.pushSourceAndOpenPr(jobId, job, packConfig, extractDir);
      await this.uploadDependencies(jobId, job, extractDir);
      await this.uploadImages(jobId, job, extractDir);

      this.patch(jobId, { status: "completed" });
      this.appendLog(jobId, "Done.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.patch(jobId, { status: "failed", errorMessage: message });
      this.appendLog(jobId, `Error: ${message}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async pushSourceAndOpenPr(
    jobId: string,
    job: WhiteningJob,
    packConfig: PackConfig,
    extractDir: string
  ) {
    const { team, project, version } = job;
    const repo = packConfig.repository;
    const sourceDir = join(extractDir, "repository", repo);
    if (!(await pathExists(sourceDir))) {
      throw new Error(`Archive is missing a repository/${repo}/ folder`);
    }

    const repoDir = join(extractDir, "repo");
    const cloneUrl = this.gitea.authenticatedCloneUrl(team, repo);
    this.appendLog(jobId, `Cloning ${team}/${repo} ...`);
    await this.runCli(jobId, "git", ["clone", "--depth", "1", cloneUrl, repoDir]);

    const branch = `whitening/${project}-${version}`;
    await this.runCli(jobId, "git", ["checkout", "-b", branch], repoDir);

    const entries = await readdir(repoDir);
    for (const entry of entries) {
      if (entry === ".git") continue;
      await rm(join(repoDir, entry), { recursive: true, force: true });
    }
    await cp(sourceDir, repoDir, { recursive: true });

    await this.runCli(jobId, "git", ["add", "-A"], repoDir);
    const { stdout: statusOutput } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: repoDir });
    if (!statusOutput.trim()) {
      this.appendLog(jobId, "No changes vs. default branch — skipping PR.");
      return;
    }

    await this.runCli(
      jobId,
      "git",
      ["-c", "user.email=whitening@devops-portal", "-c", "user.name=Whitening", "commit", "-m", `Unpack ${job.archiveName}`],
      repoDir
    );
    await this.runCli(jobId, "git", ["push", "origin", `HEAD:${branch}`], repoDir);

    // The repo we cloned, not the project name — they differ whenever
    // config.json's `repository` does.
    const base = await this.gitea.getDefaultBranch(team, repo);
    this.appendLog(jobId, `Opening PR against ${base} ...`);
    const pr = await this.gitea.createPullRequest(
      team,
      repo,
      branch,
      base,
      `Unpack ${job.archiveName}`,
      `Automated PR from the Whitening module for ${job.archiveName}.`
    );
    this.patch(jobId, { prUrl: pr.html_url });
    this.appendLog(jobId, `PR opened: ${pr.html_url}`);
  }

  private async uploadDependencies(jobId: string, job: WhiteningJob, extractDir: string) {
    const depsDir = join(extractDir, "node_modules");
    if (!(await pathExists(depsDir)) || (await readdir(depsDir)).length === 0) {
      this.appendLog(jobId, "No dependencies to upload.");
      return;
    }
    // Keep the node_modules/ prefix in Artifactory: delta packs are meant to be
    // dropped straight on top of a previous one.
    const target = `${config.artifactory.repo}/${job.team}/${job.project}/${job.version}/dependencies/node_modules/`;
    this.appendLog(jobId, `Uploading dependencies to ${target} ...`);
    await jfUpload(`${depsDir}/`, target, ["--recursive", "--flat=false"], (line) => this.appendLog(jobId, line));
  }

  private async uploadImages(jobId: string, job: WhiteningJob, extractDir: string) {
    const imagesDir = join(extractDir, "images");
    if (!(await pathExists(imagesDir))) {
      this.appendLog(jobId, "No images to upload.");
      return;
    }
    const tarFiles = (await readdir(imagesDir)).filter((f) => f.endsWith(".tar"));
    if (tarFiles.length === 0) {
      this.appendLog(jobId, "No images to upload.");
      return;
    }
    if (!config.artifactory.dockerRepo) {
      throw new Error("ARTIFACTORY_DOCKER_REPO must be set to push packed images");
    }

    const registryHost = new URL(config.artifactory.url).host;
    // ponytail: assumes the JFrog access-token-as-both-username-and-password
    // login convention for the Docker registry — adjust --dest-creds if this
    // Artifactory instance's Docker auth is set up differently.
    const creds = `${config.artifactory.token}:${config.artifactory.token}`;

    for (const tarFile of tarFiles) {
      const imageName = tarFile.replace(/\.tar$/, "");
      const target = `docker://${registryHost}/${config.artifactory.dockerRepo}/${job.team}/${job.project}/${imageName}:${job.version}`;
      this.appendLog(jobId, `Pushing ${tarFile} -> ${target} ...`);
      await this.runCli(jobId, "skopeo", [
        "copy",
        "--dest-creds",
        creds,
        `docker-archive:${join(imagesDir, tarFile)}`,
        target,
      ]);
    }
  }
}
