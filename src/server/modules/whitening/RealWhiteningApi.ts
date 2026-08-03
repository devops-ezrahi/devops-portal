import { execFile } from "child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { config } from "../../config";
import { redactSecrets } from "../../redact";
import { createTmpDir, removeTmpDir } from "../../tmp";
import { discoverPackages, packAndUpload } from "../artifactory/npmPackages";
import { BitbucketApi, BitbucketError } from "./BitbucketApi";
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
  private bitbucket = new BitbucketApi(config.git);
  /** Phase each log line gets tagged with, so the UI can collapse by step. */
  private steps = new Map<string, string>();

  private newId() {
    return `WHT-${String(++this.counter).padStart(4, "0")}`;
  }

  private patch(jobId: string, updates: Partial<WhiteningJob>) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, { ...updates, updatedAt: nowIso() });
  }

  private setStep(jobId: string, step: string) {
    this.steps.set(jobId, step);
  }

  private appendLog(jobId: string, line: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.log.push({ step: this.steps.get(jobId) ?? "General", line: redactSecrets(line) });
    job.updatedAt = nowIso();
  }

  async submitUnpack(archive: Buffer, archiveName: string, submitter: PortalUser): Promise<WhiteningJob> {
    // Extracted here rather than in run(): a bad archive must fail the request
    // (400) instead of a job. run() takes over the workDir and cleans it up.
    const workDir = await createTmpDir("wht-");
    const extractDir = join(workDir, "extracted");
    let packConfig: PackConfig;
    try {
      await mkdir(extractDir, { recursive: true });
      await writeFile(join(workDir, "pack.tgz"), archive);
      try {
        // tar ships with Linux and Windows 10+ — no unpacking library needed.
        // Relative paths run from `cwd`: GNU tar reads a leading `C:` as a
        // remote host spec and refuses to open the archive.
        await execFileAsync("tar", ["-xzf", "pack.tgz", "-C", "extracted"], { cwd: workDir });
      } catch {
        throw new Error(`Could not extract ${archiveName} — expected a .tgz from the whitening packer`);
      }
      const configPath = join(extractDir, "repository", "config.json");
      if (!(await pathExists(configPath))) {
        throw new Error("Archive is missing repository/config.json — repack it with a current whitening packer");
      }
      packConfig = parsePackConfig(await readFile(configPath, "utf8"));
    } catch (err) {
      await removeTmpDir(workDir);
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
      this.setStep(jobId, "Prepare");
      this.patch(jobId, { status: "in-progress" });
      if (!config.git.enabled) {
        throw new Error("GIT_URL and GIT_TOKEN must be set to open pull requests");
      }

      await this.pushSourceAndOpenPr(jobId, job, packConfig, extractDir);
      await this.uploadDependencies(jobId, job, extractDir, workDir);
      await this.uploadImages(jobId, job, extractDir);

      this.setStep(jobId, "Finish");
      this.patch(jobId, { status: "completed" });
      this.appendLog(jobId, "Done.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.patch(jobId, { status: "failed", errorMessage: message });
      this.appendLog(jobId, `Error: ${message}`);
    } finally {
      await removeTmpDir(workDir, (line) => this.appendLog(jobId, line));
      this.steps.delete(jobId);
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
    this.setStep(jobId, "Clone");
    const sourceDir = join(extractDir, "repository", repo);
    if (!(await pathExists(sourceDir))) {
      throw new Error(`Archive is missing a repository/${repo}/ folder`);
    }

    // Probe first: otherwise a wrong project/repo only surfaces after a clone, a
    // commit and a push have already run.
    if (!(await this.bitbucket.repoExists(team, repo))) {
      throw new Error(`Bitbucket has no repository ${team}/${repo} — check config.json's team and repository`);
    }

    const repoDir = join(extractDir, "repo");
    const cloneUrl = this.bitbucket.authenticatedCloneUrl(team, repo);
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

    this.setStep(jobId, "Commit & push");
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
    // --force because the branch is ours: re-whitening the same project+version
    // must update it rather than die on a non-fast-forward.
    await this.runCli(jobId, "git", ["push", "--force", "origin", `HEAD:${branch}`], repoDir);

    this.setStep(jobId, "Pull request");
    // The repo we cloned, not the project name — they differ whenever
    // config.json's `repository` does.
    const base = await this.bitbucket.getDefaultBranch(team, repo);
    this.appendLog(jobId, `Opening PR against ${base} ...`);

    let url: string;
    try {
      url = await this.bitbucket.createPullRequest(
        team,
        repo,
        branch,
        base,
        `Unpack ${job.archiveName}`,
        `Automated PR from the Whitening module for ${job.archiveName}.`
      );
    } catch (err) {
      // 409 = a PR from this branch is already open. That is the "already
      // whitened" case: point at the existing one instead of failing the job.
      if (!(err instanceof BitbucketError) || err.status !== 409) throw err;
      const existing = await this.bitbucket.findOpenPullRequest(team, repo, branch);
      if (!existing) throw err;
      this.appendLog(jobId, "A pull request from this branch is already open — reusing it.");
      url = existing;
    }

    this.patch(jobId, { prUrl: url });
    this.appendLog(jobId, `PR opened: ${url}`);
  }

  private async uploadDependencies(jobId: string, job: WhiteningJob, extractDir: string, workDir: string) {
    this.setStep(jobId, "Dependencies");
    const depsDir = join(extractDir, "node_modules");
    if (!(await pathExists(depsDir)) || (await readdir(depsDir)).length === 0) {
      this.appendLog(jobId, "No dependencies to upload.");
      return;
    }

    const packages = await discoverPackages(depsDir, (line) => this.appendLog(jobId, line));
    if (packages.length === 0) {
      this.appendLog(jobId, "No npm packages found under node_modules/.");
      return;
    }

    this.appendLog(jobId, `Found ${packages.length} package(s).`);
    const results = await packAndUpload(
      packages,
      join(workDir, "stage"),
      (line) => this.appendLog(jobId, line),
      () => {}
    );

    const failures = results.filter((r) => r.status === "failed");
    if (failures.length > 0) {
      throw new Error(`${failures.length} of ${results.length} dependency package(s) failed to upload`);
    }
  }

  private async uploadImages(jobId: string, job: WhiteningJob, extractDir: string) {
    this.setStep(jobId, "Images");
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
