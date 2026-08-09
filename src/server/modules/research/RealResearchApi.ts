import { execFile, spawn } from "child_process";
import { mkdir, stat } from "fs/promises";
import { platform, tmpdir } from "os";
import { dirname, join } from "path";
import { promisify } from "util";
import { config } from "../../config";
import { redactSecrets } from "../../redact";
import type { PortalUser, ResearchApi, ResearchJob } from "../../types";

const execFileAsync = promisify(execFile);
const isWindows = platform() === "win32";

// ponytail: fixed 5m ceiling — opencode retries silently forever on a bad/
// exhausted API key rather than erroring, so this is the only thing that
// stops a job hanging forever. Make it configurable if real questions
// routinely need longer.
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

// opencode writes its tool-use trace (glob/read/bash calls) to stderr, ANSI-
// colored, with a "> build · <model>" banner line — this strips both down to
// plain text so it can be shown as the job's "thinking".
function stripOpencodeChrome(stderr: string): string | undefined {
  const lines = stderr
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("> build"));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class RealResearchApi implements ResearchApi {
  private jobs = new Map<string, ResearchJob>();
  private counter = 0;
  /** One per running job, so `cancelJob`/timeout can stop the work already in flight. */
  private controllers = new Map<string, AbortController>();

  private newId() {
    return `RES-${String(++this.counter).padStart(4, "0")}`;
  }

  private patch(jobId: string, updates: Partial<ResearchJob>) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, { ...updates, updatedAt: nowIso() });
  }

  private appendLog(jobId: string, line: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.log.push({ step: "Research", line: redactSecrets(line) });
    job.updatedAt = nowIso();
  }

  private cloneDirFor(project: string): string {
    const safe = project.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(tmpdir(), "research-clones", safe);
  }

  listProjects(): string[] {
    return Object.keys(config.research.projects);
  }

  async submitQuestion(project: string, question: string, submitter: PortalUser): Promise<ResearchJob> {
    const job: ResearchJob = {
      id: this.newId(),
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      project,
      question,
      log: [],
    };
    this.jobs.set(job.id, job);
    void this.run(job.id, project, question);
    return job;
  }

  async listJobs(user: PortalUser, allUsers = false): Promise<ResearchJob[]> {
    return [...this.jobs.values()]
      .filter((j) => allUsers || j.submittedBy === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getJob(jobId: string): Promise<ResearchJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async cancelJob(jobId: string, user: PortalUser, allUsers = false): Promise<ResearchJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (!allUsers && job.submittedBy !== user.id) {
      throw new Error("Forbidden: not your job");
    }
    if (job.status !== "pending" && job.status !== "in-progress") return job;

    this.patch(jobId, { status: "aborted", errorMessage: undefined });
    this.appendLog(jobId, `Aborted by ${user.displayName}.`);
    this.controllers.get(jobId)?.abort();
    return job;
  }

  private async run(jobId: string, project: string, question: string) {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    const signal = controller.signal;

    const timeout = setTimeout(() => {
      if (this.jobs.get(jobId)?.status === "in-progress") {
        this.appendLog(
          jobId,
          `Timed out after ${RUN_TIMEOUT_MS / 60000}m waiting on opencode — check OPENCODE_API_KEY / provider rate limits.`
        );
        this.patch(jobId, { status: "failed", errorMessage: "Timed out waiting on opencode" });
      }
      controller.abort();
    }, RUN_TIMEOUT_MS);

    try {
      this.patch(jobId, { status: "in-progress" });

      const repoUrl = config.research.projects[project];
      if (!repoUrl) throw new Error(`Unknown project "${project}"`);
      const cloneDir = this.cloneDirFor(project);

      if (!(await pathExists(cloneDir))) {
        this.appendLog(jobId, `Cloning ${project} ...`);
        await mkdir(dirname(cloneDir), { recursive: true });
        await this.runCli(jobId, "git", ["clone", "--depth", "1", repoUrl, cloneDir], undefined, signal);
      } else {
        this.appendLog(jobId, `Using existing clone of ${project}.`);
      }

      this.appendLog(jobId, "Asking opencode ...");
      const { answer, thinking } = await this.askOpencode(jobId, cloneDir, question, signal);

      if (this.jobs.get(jobId)?.status === "in-progress") {
        this.patch(jobId, { status: "completed", answer, thinking });
        this.appendLog(jobId, "Done.");
      }
    } catch (err) {
      if (this.jobs.get(jobId)?.status === "in-progress") {
        const message = err instanceof Error ? err.message : String(err);
        this.patch(jobId, { status: "failed", errorMessage: message });
        this.appendLog(jobId, `Error: ${message}`);
      }
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(jobId);
    }
  }

  private askOpencode(
    jobId: string,
    cwd: string,
    question: string,
    signal: AbortSignal
  ): Promise<{ answer: string; thinking?: string }> {
    // opencode resolves provider credentials from a PROVIDER_API_KEY env var,
    // e.g. anthropic/claude-sonnet-5 -> ANTHROPIC_API_KEY.
    const provider = config.research.model.split("/")[0] || "anthropic";
    const envVar = `${provider.toUpperCase()}_API_KEY`;
    const env = { ...process.env, [envVar]: config.research.apiKey };
    this.appendLog(jobId, `$ opencode run --dir ${cwd} --model ${config.research.model} "<question>"`);

    // spawn, not execFile: execFile only hands back stdout/stderr once the
    // process exits, so the job's "thinking" only appeared after opencode had
    // already finished. Reading the streams as data arrives lets each poll
    // show more of the trace while the job is still in-progress.
    //
    // Plain spawn("opencode", [...]) hangs indefinitely on Windows when its
    // parent is node.exe rather than an interactive shell — reproduced with
    // an A/B test (same command, same machine, immediately sequential:
    // direct-under-bash succeeds in seconds, node-spawned hangs every time
    // regardless of shell/stdio/exe-path options tried). Not a quoting or
    // EINVAL issue — genuinely parent-process-specific. Windows dev routes
    // through the git-bash shell that's proven to work; question travels via
    // an env var so bash's `"$VAR"` expansion handles quoting, no cmd.exe,
    // no manual escaping. Production is the Linux image, where a plain spawn
    // already works (proven in this same investigation).
    const [bin, args, spawnEnv] = isWindows
      ? [
          "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
          ["-c", 'opencode run --dir "$R_DIR" --model "$R_MODEL" --auto "$R_QUESTION" < /dev/null'],
          { ...env, R_DIR: cwd, R_MODEL: config.research.model, R_QUESTION: question },
        ]
      : (["opencode", ["run", "--dir", cwd, "--model", config.research.model, "--auto", question], env] as const);

    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env: spawnEnv, signal, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk;
        const thinking = stripOpencodeChrome(stderr);
        if (thinking) this.patch(jobId, { thinking: redactSecrets(thinking) });
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        reject(err.code === "ENOENT" ? new Error("opencode not found — ensure it is on PATH") : err);
      });
      child.on("close", (code) => {
        if (code === 0) {
          const thinking = stripOpencodeChrome(stderr);
          resolve({
            answer: stdout.trim() || "(opencode returned no answer)",
            thinking: thinking ? redactSecrets(thinking) : undefined,
          });
          return;
        }
        const detail = [stderr, stdout].find(Boolean) ?? `opencode exited with code ${code}`;
        reject(new Error((stripOpencodeChrome(detail) ?? detail).trim()));
      });
    });
  }

  private async runCli(jobId: string, bin: string, args: string[], cwd: string | undefined, signal: AbortSignal) {
    this.appendLog(jobId, `$ ${bin} ${args.join(" ")}`);
    try {
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
}
