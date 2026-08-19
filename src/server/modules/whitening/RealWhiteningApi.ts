import { execFile } from "child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
// Rejects on abort, so a cancelled simulation stops mid-sleep instead of at the
// end of the current beat.
import { setTimeout as sleep } from "timers/promises";
import { promisify } from "util";
import { config } from "../../config";
import { describeError, log, userMessage } from "../../log";
import { redactSecrets } from "../../redact";
import { createTmpDir, removeTmpDir } from "../../tmp";
import { discoverPackages, packAndUpload } from "../artifactory/npmPackages";
import { BitbucketApi, BitbucketError } from "./BitbucketApi";
import { simulatedWhiteningJob, whiteningSimulation } from "./devSimulation";
import type { PortalUser, WhiteningApi, WhiteningJob, WhiteningScenario } from "../../types";

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
  /** One per running job, so `cancelJob` can stop the work already in flight. */
  private controllers = new Map<string, AbortController>();

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

  // Mirrored to stdout with the job id and the current step, so `kubectl logs`
  // tells the same story the job drawer does — including the `$ git ...` and
  // `$ skopeo ...` command echoes, which is where these runs actually fail.
  private appendLog(jobId: string, line: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const step = this.steps.get(jobId) ?? "General";
    job.log.push({ step, line: redactSecrets(line) });
    job.updatedAt = nowIso();
    log.info(`whitening ${jobId}`, `[${step}] ${line}`);
  }

  /**
   * True once the user has stopped the job. `run`'s catch consults it: the
   * killed child process must not relabel an aborted job as failed.
   */
  private aborted(jobId: string): boolean {
    return this.jobs.get(jobId)?.status === "aborted";
  }

  private start(jobId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    return controller.signal;
  }

  async submitUnpack(archive: Buffer, archiveName: string, submitter: PortalUser): Promise<WhiteningJob> {
    // Extracted here rather than in run(): a bad archive must fail the request
    // (400) instead of a job. run() takes over the workDir and cleans it up.
    const workDir = await createTmpDir("wht-");
    const extractDir = join(workDir, "extracted");
    let packConfig: PackConfig;
    try {
      await mkdir(extractDir, { recursive: true });
      // Zip needs its own extractor: Debian's GNU tar cannot read the format at
      // all. (It appears to work on Windows only because tar.exe there is
      // bsdtar.) The runtime image installs unzip for this — see Dockerfile.
      const isZip = /\.zip$/i.test(archiveName);
      const packFile = isZip ? "pack.zip" : "pack.tgz";
      await writeFile(join(workDir, packFile), archive);
      try {
        // tar ships with Linux and Windows 10+ — no unpacking library needed.
        // Relative paths run from `cwd`: GNU tar reads a leading `C:` as a
        // remote host spec and refuses to open the archive.
        await execFileAsync(
          isZip ? "unzip" : "tar",
          isZip ? ["-q", packFile, "-d", "extracted"] : ["-xzf", packFile, "-C", "extracted"],
          { cwd: workDir }
        );
      } catch (err) {
        // unzip exits 1 for "extracted, with warnings" and only >= 2 for a real
        // failure. A zip built on Windows warns about backslash separators and
        // still unpacks correctly, so treating 1 as fatal would reject packs
        // that are perfectly usable.
        const code = (err as { code?: number }).code;
        if (!isZip || code !== 1) {
          throw new Error(
            `Could not extract ${archiveName} — expected a .tgz or .zip from the whitening packer`
          );
        }
      }
      const configPath = join(extractDir, "repository", "config.json");
      if (!(await pathExists(configPath))) {
        throw new Error("Archive is missing repository/config.json — repack it with a current whitening packer");
      }
      packConfig = parsePackConfig(await readFile(configPath, "utf8"));
    } catch (err) {
      // No job exists yet, so this failure has no job log to land in — without
      // a line here a rejected pack is invisible outside the 400 the user got.
      log.warn("whitening", `rejected ${archiveName} from ${submitter.id}: ${describeError(err)}`, {
        bytes: archive.length,
      });
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
    log.info("whitening", `${job.id} submitted`, {
      by: submitter.id,
      archive: archiveName,
      bytes: archive.length,
      department,
      team,
      project,
      version,
    });
    void this.run(job.id, workDir, extractDir, packConfig);
    return job;
  }

  async simulate(submitter: PortalUser, scenario: WhiteningScenario = "success"): Promise<WhiteningJob> {
    const job: WhiteningJob = {
      id: this.newId(),
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      log: [],
      ...simulatedWhiteningJob(),
    };
    this.jobs.set(job.id, job);
    void this.runSimulation(job.id, scenario);
    return job;
  }

  private async runSimulation(jobId: string, scenario: WhiteningScenario) {
    const signal = this.start(jobId);
    try {
      for (const beat of whiteningSimulation(scenario)) {
        await sleep(beat.ms, undefined, { signal });
        if (beat.step) this.setStep(jobId, beat.step);
        if (beat.patch) this.patch(jobId, beat.patch);
        if (beat.line) this.appendLog(jobId, beat.line);
      }
    } catch {
      // Only sleep() rejects here, and only because the job was cancelled.
    } finally {
      this.controllers.delete(jobId);
      this.steps.delete(jobId);
    }
  }

  async listJobs(user: PortalUser, allUsers = false): Promise<WhiteningJob[]> {
    return [...this.jobs.values()]
      .filter((j) => allUsers || j.submittedBy === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getJob(jobId: string): Promise<WhiteningJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async cancelJob(jobId: string, user: PortalUser, allUsers = false): Promise<WhiteningJob | null> {
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

  private async runCli(jobId: string, bin: string, args: string[], cwd?: string) {
    this.appendLog(jobId, `$ ${bin} ${args.join(" ")}`);
    try {
      // The job's signal kills the child, so Stop lands mid-clone rather than
      // at the next step boundary. Looked up rather than threaded through every
      // step's signature.
      const signal = this.controllers.get(jobId)?.signal;
      const result = await execFileAsync(bin, args, { cwd, maxBuffer: 20 * 1024 * 1024, signal });
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
    this.start(jobId);
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
      if (!this.aborted(jobId)) {
        const message = userMessage(err);
        this.patch(jobId, { status: "failed", errorMessage: message });
        this.appendLog(jobId, `Error: ${message}`);
        // The stack and cause chain, which the user-facing job log omits.
        log.error("whitening", `${jobId} failed at step ${this.steps.get(jobId) ?? "?"}`, err);
      }
    } finally {
      await removeTmpDir(workDir, (line) => this.appendLog(jobId, line));
      this.steps.delete(jobId);
      this.controllers.delete(jobId);
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
      () => {},
      this.controllers.get(jobId)?.signal
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
