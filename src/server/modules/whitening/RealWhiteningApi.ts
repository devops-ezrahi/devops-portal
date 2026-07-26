import { execFile } from "child_process";
import { cp, mkdir, readdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { randomUUID } from "crypto";
import AdmZip from "adm-zip";
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
  team: string;
  /** Repo name on the closed-network git — may differ from the project name. */
  repo: string;
  /** Glob patterns (git pathspec syntax) kept out of the pull request. */
  exclude: string[];
};

// config.json sits at the zip root; the packer writes it (see
// "whitening packer"/pack.py load_pack_config).
export function parsePackConfig(text: string): PackConfig {
  let raw: Partial<PackConfig>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("config.json in the zip is not valid JSON");
  }
  const { project, version, team } = raw;
  if (!project || !version || !team) {
    throw new Error("config.json must set project, version and team");
  }
  return { project, version, team, repo: raw.repo || project, exclude: raw.exclude ?? [] };
}

function readPackConfig(zip: AdmZip): PackConfig {
  const entry = zip.getEntry("config.json");
  if (!entry) {
    throw new Error("Zip is missing config.json — repack it with a current whitening packer");
  }
  return parsePackConfig(zip.readAsText(entry));
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

  async submitUnpack(zipBuffer: Buffer, zipName: string, submitter: PortalUser): Promise<WhiteningJob> {
    const zip = new AdmZip(zipBuffer);
    const packConfig = readPackConfig(zip);
    const { team, project, version } = packConfig;
    const job: WhiteningJob = {
      id: this.newId(),
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      zipName,
      team,
      project,
      version,
      log: [],
    };
    this.jobs.set(job.id, job);
    void this.run(job.id, zip, packConfig);
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

  private async run(jobId: string, zip: AdmZip, packConfig: PackConfig) {
    const job = this.jobs.get(jobId)!;
    const workDir = join(tmpdir(), `whitening-${randomUUID()}`);
    try {
      this.patch(jobId, { status: "in-progress" });
      if (!config.git.enabled) {
        throw new Error("GIT_URL and GIT_TOKEN must be set to open pull requests");
      }

      await mkdir(workDir, { recursive: true });
      const extractDir = join(workDir, "extracted");
      this.appendLog(jobId, "Extracting zip ...");
      zip.extractAllTo(extractDir, true);

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
    const repo = packConfig.repo;
    const sourceDir = join(extractDir, "source");
    if (!(await pathExists(sourceDir))) {
      throw new Error("Zip is missing a source/ folder");
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
    if (packConfig.exclude.length > 0) {
      // Unstaging is what "exclude" means here: excluded files the zip brought
      // stay untracked, and ones the repo already had keep their committed
      // version instead of being deleted by our wipe-and-copy above.
      this.appendLog(jobId, `Excluding ${packConfig.exclude.join(", ")} from the PR ...`);
      await this.runCli(jobId, "git", ["reset", "-q", "--", ...packConfig.exclude], repoDir);
    }
    // Staged-only: excluded files linger as untracked/modified in the worktree
    // and must not count as changes.
    const { stdout: statusOutput } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: repoDir });
    if (!statusOutput.trim()) {
      this.appendLog(jobId, "No changes vs. default branch — skipping PR.");
      return;
    }

    await this.runCli(
      jobId,
      "git",
      ["-c", "user.email=whitening@devops-portal", "-c", "user.name=Whitening", "commit", "-m", `Unpack ${job.zipName}`],
      repoDir
    );
    await this.runCli(jobId, "git", ["push", "origin", `HEAD:${branch}`], repoDir);

    const base = await this.gitea.getDefaultBranch(team, project);
    this.appendLog(jobId, `Opening PR against ${base} ...`);
    const pr = await this.gitea.createPullRequest(
      team,
      project,
      branch,
      base,
      `Unpack ${job.zipName}`,
      `Automated PR from the Whitening module for ${job.zipName}.`
    );
    this.patch(jobId, { prUrl: pr.html_url });
    this.appendLog(jobId, `PR opened: ${pr.html_url}`);
  }

  private async uploadDependencies(jobId: string, job: WhiteningJob, extractDir: string) {
    const depsDir = join(extractDir, "dependencies");
    if (!(await pathExists(depsDir)) || (await readdir(depsDir)).length === 0) {
      this.appendLog(jobId, "No dependencies to upload.");
      return;
    }
    const target = `${config.artifactory.repo}/${job.team}/${job.project}/${job.version}/dependencies/`;
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
