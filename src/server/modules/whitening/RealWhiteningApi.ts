import { execFile } from "child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
// Rejects on abort, so a cancelled simulation stops mid-sleep instead of at the
// end of the current beat.
import { setTimeout as sleep } from "timers/promises";
import { promisify } from "util";
import { config } from "../../config";
import { JobStore } from "../../jobStore";
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

// whitening.json at the root of the *target* repo — the closed-network side, not
// the pack. `preserve` lists paths the PR must never delete; the packer's own
// keys (`images`) live in the same file on the source side and are ignored here.
export function parsePreserve(text: string): string[] {
  let raw: { preserve?: unknown };
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("whitening.json in the repository is not valid JSON");
  }
  if (!Array.isArray(raw.preserve)) return [];
  return raw.preserve.filter((p): p is string => typeof p === "string" && p.trim() !== "");
}

/**
 * Read the target repo's preserve list. Missing file is the normal case; a
 * malformed one throws, because silently ignoring a protect-list deletes the
 * very files it was written to save.
 */
async function readPreserve(repoDir: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(repoDir, "whitening.json"), "utf8");
  } catch {
    return [];
  }
  // The file that says "don't delete these" must not delete itself, or the next
  // PR finds no list at all.
  return ["whitening.json", ...parsePreserve(text)];
}

/**
 * Of the changes currently staged, the ones a preserve pattern covers: `"D"` for
 * the deletions the wipe staged, `"M"` for paths the pack ships on top of a file
 * the repo already had — the ones the user is asked about.
 * Globbing is git's (`:(glob)` pathspecs handle `*`, `**`, `?`) rather than a
 * dependency's — the module already shells out to git for everything.
 */
export async function preservedChanges(
  repoDir: string,
  preserve: string[],
  filter: "D" | "M"
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--cached", "--name-only", `--diff-filter=${filter}`, "--", ...preserve.map((p) => `:(glob)${p}`)],
    { cwd: repoDir }
  );
  return stdout.split("\n").filter(Boolean);
}

export class RealWhiteningApi implements WhiteningApi {
  private readonly jobs: JobStore<WhiteningJob>;
  private bitbucket = new BitbucketApi(config.git);
  /** Phase each log line gets tagged with, so the UI can collapse by step. */
  private steps = new Map<string, string>();
  /** One per running job, so `cancelJob` can stop the work already in flight. */
  private controllers = new Map<string, AbortController>();
  /** Resolver of the promise a job waiting on a preserve decision is parked on. */
  private decisions = new Map<string, (keep: string[]) => void>();

  /** `dataDir` is a parameter purely so tests can point it at a mkdtemp. */
  constructor(dataDir: string = config.dataDir) {
    this.jobs = new JobStore<WhiteningJob>(join(dataDir, "whitening"), "WHT");
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
      id: this.jobs.nextId(),
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
    this.jobs.add(job);
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
      id: this.jobs.nextId(),
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      log: [],
      ...simulatedWhiteningJob(),
    };
    this.jobs.add(job);
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
        if (beat.ask) {
          const keep = await this.askPreserve(jobId, beat.ask);
          this.appendLog(jobId, `Kept the repository's version of ${keep.length} of ${beat.ask.length} preserved file(s).`);
        }
      }
    } catch {
      // Only sleep() and askPreserve reject here, and only on a cancelled job.
    } finally {
      this.controllers.delete(jobId);
      this.steps.delete(jobId);
      await this.jobs.settle(jobId);
    }
  }

  async listJobs(user: PortalUser, allUsers = false): Promise<WhiteningJob[]> {
    // Logs are stripped here — the drawer fetches the full job by id.
    return this.jobs
      .all()
      .filter((j) => allUsers || j.submittedBy === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getJob(jobId: string): Promise<WhiteningJob | null> {
    return this.jobs.read(jobId);
  }

  async cancelJob(jobId: string, user: PortalUser, allUsers = false): Promise<WhiteningJob | null> {
    // Live first, disk second: cancelling a job that just finished returns it
    // rather than 404ing, which is what it did while everything was in memory.
    const job = this.jobs.get(jobId) ?? (await this.jobs.read(jobId));
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

  /**
   * Hold the run until someone decides which side of each conflicting preserved
   * file wins. `pendingPreserve` on the job is the whole signal — the status
   * stays `in-progress`, so a wait cut short by a restart is already swept into
   * "Interrupted by a server restart" by the job store, and Stop still works
   * because the job's own signal rejects this.
   */
  private askPreserve(jobId: string, files: string[]): Promise<string[]> {
    this.patch(jobId, { pendingPreserve: files });
    this.appendLog(
      jobId,
      `${files.length} preserved file(s) also ship in this pack — waiting for a keep/import decision.`
    );
    const signal = this.controllers.get(jobId)?.signal;
    return new Promise<string[]>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Aborted while waiting for a preserve decision"));
        return;
      }
      this.decisions.set(jobId, resolve);
      signal?.addEventListener("abort", () => reject(new Error("Aborted while waiting for a preserve decision")), {
        once: true,
      });
    }).finally(() => {
      this.decisions.delete(jobId);
      this.patch(jobId, { pendingPreserve: undefined });
    });
  }

  async resolvePreserve(
    jobId: string,
    keep: string[],
    user: PortalUser,
    allUsers = false
  ): Promise<WhiteningJob | null> {
    const job = this.jobs.get(jobId);
    if (!job?.pendingPreserve?.length) return null;
    if (!allUsers && job.submittedBy !== user.id) {
      throw new Error("Forbidden: not your job");
    }
    // These paths end up on a git command line, so only the ones actually in
    // question are honoured.
    const pending = job.pendingPreserve;
    this.decisions.get(jobId)?.(keep.filter((p) => pending.includes(p)));
    return job;
  }

  /** Put the repository's committed version of these paths back over the pack's. */
  private restoreFromHead(jobId: string, repoDir: string, paths: string[]) {
    return this.runCli(jobId, "git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths], repoDir);
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
      await this.uploadDependencies(jobId, extractDir, workDir);
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
      // Terminal by now on every path, and after the last appendLog above —
      // this is where the job and its log leave memory for the volume.
      await this.jobs.settle(jobId);
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

    // Before the wipe below destroys it — this is the target repo's own file.
    const preserve = await readPreserve(repoDir);

    const entries = await readdir(repoDir);
    for (const entry of entries) {
      if (entry === ".git") continue;
      await rm(join(repoDir, entry), { recursive: true, force: true });
    }
    await cp(sourceDir, repoDir, { recursive: true });

    this.setStep(jobId, "Commit & push");
    await this.runCli(jobId, "git", ["add", "-A"], repoDir);

    // Undo only the *deletions* the wipe staged for preserved paths: a file the
    // pack also ships keeps the packed content. Must run before the "no changes"
    // check below, or a PR whose whole diff was those deletions still opens.
    if (preserve.length) {
      const kept = await preservedChanges(repoDir, preserve, "D");
      if (kept.length) {
        await this.restoreFromHead(jobId, repoDir, kept);
        this.appendLog(jobId, `Kept ${kept.length} file(s) marked preserve in whitening.json.`);
      }

      // A preserved path the pack *also* ships is a question, not a default: the
      // job stops here until someone says which side wins, per file.
      const conflicts = await preservedChanges(repoDir, preserve, "M");
      if (conflicts.length) {
        const keep = await this.askPreserve(jobId, conflicts);
        if (keep.length) await this.restoreFromHead(jobId, repoDir, keep);
        this.appendLog(
          jobId,
          `Kept the repository's version of ${keep.length} of ${conflicts.length} preserved file(s); imported the rest from the pack.`
        );
      }
    }

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

  private async uploadDependencies(jobId: string, extractDir: string, workDir: string) {
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
