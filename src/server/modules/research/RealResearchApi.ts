import { execFile } from "child_process";
import { mkdir, stat } from "fs/promises";
import { platform, tmpdir } from "os";
import { dirname, join } from "path";
import { promisify } from "util";
import { config } from "../../config";
import { redactSecrets } from "../../redact";
import type { PortalUser, ResearchApi, ResearchJob } from "../../types";

const execFileAsync = promisify(execFile);

// Node's execFile does a plain PATH lookup (no shell), which is fine on
// Linux where `npm install -g` puts a real executable on PATH — but on
// Windows the global bin is a `.cmd` shim, and execFile won't resolve it
// without the extension (shelling out with `shell: true` instead would
// re-open command injection via the untrusted question text, so this is
// the safer fix).
const OPENCODE_BIN = platform() === "win32" ? "opencode.cmd" : "opencode";

// ponytail: fixed 5m ceiling — opencode retries silently forever on a bad/
// exhausted API key rather than erroring, so this is the only thing that
// stops a job hanging forever. Make it configurable if real questions
// routinely need longer.
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

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
      const answer = await this.askOpencode(jobId, cloneDir, question, signal);

      if (this.jobs.get(jobId)?.status === "in-progress") {
        this.patch(jobId, { status: "completed", answer });
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

  private async askOpencode(jobId: string, cwd: string, question: string, signal: AbortSignal): Promise<string> {
    // opencode resolves provider credentials from a PROVIDER_API_KEY env var,
    // e.g. anthropic/claude-sonnet-5 -> ANTHROPIC_API_KEY.
    const provider = config.research.model.split("/")[0] || "anthropic";
    const envVar = `${provider.toUpperCase()}_API_KEY`;
    this.appendLog(jobId, `$ opencode run --dir ${cwd} --model ${config.research.model} "<question>"`);
    try {
      const result = await execFileAsync(
        OPENCODE_BIN,
        ["run", "--dir", cwd, "--model", config.research.model, "--auto", question],
        {
          maxBuffer: 20 * 1024 * 1024,
          signal,
          env: { ...process.env, [envVar]: config.research.apiKey },
          // ponytail: .cmd shims can't be spawned directly on Windows (EINVAL)
          // without shell:true. Scoped to win32 only — production is the
          // Linux image, a real executable on PATH, no shell needed there, so
          // this never widens the injection surface the baked opencode.json
          // permission deny-list is actually guarding against.
          shell: platform() === "win32",
        }
      );
      return result.stdout.trim() || "(opencode returned no answer)";
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      if (e.code === "ENOENT") throw new Error("opencode not found — ensure it is on PATH");
      const detail = [e.stderr, e.stdout, e.message].find(Boolean) ?? "opencode command failed";
      throw new Error(detail.toString().trim());
    }
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
