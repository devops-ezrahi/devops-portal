import { execFile, spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { mkdir, stat } from "fs/promises";
import { platform, tmpdir } from "os";
import { dirname, join } from "path";
import { promisify } from "util";
import { config } from "../../config";
import { redactSecrets } from "../../redact";
import type { PortalUser, AiApi, AiCategory, AiConversation, AiJob } from "../../types";

const execFileAsync = promisify(execFile);
const isWindows = platform() === "win32";

// ponytail: fixed 5m ceiling — opencode retries silently forever on a bad/
// exhausted API key rather than erroring, so this is the only thing that
// stops a job hanging forever. Make it configurable if real questions
// routinely need longer.
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

// Read-only, enforced in code rather than by a mounted file. This used to live
// only in docker/opencode.json, which meant dev (where opencode auto-creates an
// EMPTY ~/.config/opencode/opencode.jsonc) had no deny rules at all — combined
// with --auto, the agent could edit files in the clone. That failure mode is
// fail-OPEN, so the policy now travels with the code: written to disk at
// startup and passed via OPENCODE_CONFIG, which takes precedence over any
// ambient user/project config. A missing mount can no longer grant write access.
const OPENCODE_POLICY = {
  $schema: "https://opencode.ai/config.json",
  permission: {
    read: "allow",
    glob: "allow",
    grep: "allow",
    skill: "allow",
    lsp: "allow",
    edit: "deny",
    write: "deny",
    patch: "deny",
    bash: "deny",
    webfetch: "deny",
    websearch: "deny",
    task: "deny",
    external_directory: "deny",
    question: "deny",
  },
};

/** `anthropic/claude-sonnet-5` -> `anthropic`. */
function providerOf(model: string): string {
  return model.split("/")[0] || "anthropic";
}

/**
 * Embeds GIT_TOKEN into the clone URL, same auth form the Whitening module's
 * BitbucketApi.authenticatedCloneUrl uses — registered ai-* projects live on
 * the same Bitbucket instance. Left alone when GIT_URL/GIT_TOKEN aren't set,
 * or when repoUrl isn't an http(s) URL `new URL` can rewrite (an SSH form
 * like `git@host:org/repo.git`, e.g. the ai-homelab skill's GitHub repo,
 * authenticates via the machine's own SSH key instead) — so a public or
 * SSH-auth'd repoUrl still clones. Only applied once, at clone time: `git
 * fetch origin` on later questions reuses the credentialed origin already
 * stored in the clone's own .git/config.
 */
export function authenticatedRepoUrl(repoUrl: string): string {
  if (!config.git.enabled) return repoUrl;
  let u: URL;
  try {
    u = new URL(repoUrl);
  } catch {
    return repoUrl;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return repoUrl;
  if (config.git.username) {
    u.username = config.git.username;
    u.password = config.git.token;
  } else {
    u.username = config.git.token;
  }
  return u.toString();
}

/**
 * Written once per process; opencode reads it via OPENCODE_CONFIG.
 *
 * OPENCODE_BASE_URL rides along in the same file because opencode exposes no
 * env var for it — a custom endpoint is only `provider.<id>.options.baseURL`.
 * The id is the provider half of OPENCODE_MODEL, so pointing the module at a
 * gateway means setting both vars together.
 */
function writeOpencodePolicy(): string {
  const dir = join(tmpdir(), "ai-opencode");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.json");
  const baseUrl = config.ai.baseUrl;
  const contents = baseUrl
    ? {
        ...OPENCODE_POLICY,
        provider: { [providerOf(config.ai.model)]: { options: { baseURL: baseUrl } } },
      }
    : OPENCODE_POLICY;
  writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

const OPENCODE_CONFIG_PATH = writeOpencodePolicy();

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

function truncateTitle(question: string): string {
  return question.length > 60 ? question.slice(0, 60) + "…" : question;
}

type OpencodeEvent = {
  type: string;
  sessionID?: string;
  part?: {
    tool?: string;
    text?: string;
    state?: { input?: unknown };
  };
};

export class RealAiApi implements AiApi {
  private conversations = new Map<string, AiConversation>();
  private jobs = new Map<string, AiJob>();
  private conversationCounter = 0;
  private jobCounter = 0;
  /** One per running job, so `cancelJob`/timeout can stop the work already in flight. */
  private controllers = new Map<string, AbortController>();

  private newConversationId() {
    return `CONV-${String(++this.conversationCounter).padStart(4, "0")}`;
  }

  private newJobId() {
    return `RES-${String(++this.jobCounter).padStart(4, "0")}`;
  }

  private patchConversation(conversationId: string, updates: Partial<AiConversation>) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    Object.assign(conversation, { ...updates, updatedAt: nowIso() });
  }

  private patch(jobId: string, updates: Partial<AiJob>) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job, { ...updates, updatedAt: nowIso() });
  }

  private appendLog(jobId: string, line: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.log.push({ step: "AI", line: redactSecrets(line) });
    job.updatedAt = nowIso();
  }

  private cloneDirFor(project: string): string {
    const safe = project.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(tmpdir(), "ai-clones", safe);
  }

  /**
   * "I'm not sure" conversations: pick a category from the question text
   * itself, using the same skill-derived category list the picker shows —
   * one opencode call, no repo clone needed since it only reasons over the
   * category descriptions we already have, not any file contents.
   */
  private async classifyProject(jobId: string, question: string, signal: AbortSignal): Promise<string> {
    const categories = this.listCategories();
    if (categories.length === 0) throw new Error("No AI categories configured");
    if (categories.length === 1) return categories[0].name;

    this.appendLog(jobId, "Figuring out which repo fits your question ...");
    const scratchDir = join(tmpdir(), "ai-clones", "_classify");
    await mkdir(scratchDir, { recursive: true });

    const list = categories.map((c) => `- ${c.name}: ${c.description}`).join("\n");
    const prompt =
      `Categories:\n${list}\n\nQuestion: ${question}\n\n` +
      `Which category best fits this question? Reply with ONLY the category name from the list above, nothing else.`;

    const { answer } = await this.askOpencode(jobId, scratchDir, prompt, undefined, signal);
    const picked = answer.trim().split("\n")[0].replace(/[.:,]+$/, "").trim().toLowerCase();
    const match = categories.find((c) => c.name.toLowerCase() === picked || picked.includes(c.name.toLowerCase()));
    if (!match) {
      throw new Error(`Couldn't tell which repo fits (got "${answer.trim()}") — start a new chat and pick one explicitly.`);
    }
    this.appendLog(jobId, `Chose: ${match.name}`);
    return match.name;
  }

  listCategories(): AiCategory[] {
    return Object.entries(config.ai.projects).map(([name, p]) => ({ name, description: p.description }));
  }

  async startConversation(project: string | null, submitter: PortalUser): Promise<AiConversation> {
    if (project && !config.ai.projects[project]) throw new Error(`Unknown project "${project}"`);
    const conversation: AiConversation = {
      id: this.newConversationId(),
      title: "",
      project,
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async listConversations(user: PortalUser, allUsers = false): Promise<AiConversation[]> {
    return [...this.conversations.values()]
      .filter((c) => allUsers || c.submittedBy === user.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async submitQuestion(conversationId: string, question: string, submitter: PortalUser): Promise<AiJob> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    if (!conversation.title) this.patchConversation(conversationId, { title: truncateTitle(question) });

    const job: AiJob = {
      id: this.newJobId(),
      conversationId,
      status: "pending",
      submittedBy: submitter.id,
      submittedByName: submitter.displayName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      project: conversation.project ?? "",
      question,
      log: [],
    };
    this.jobs.set(job.id, job);
    void this.run(job.id, conversationId, question);
    return job;
  }

  async listJobs(conversationId: string, user: PortalUser, allUsers = false): Promise<AiJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.conversationId === conversationId && (allUsers || j.submittedBy === user.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getJob(jobId: string): Promise<AiJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async cancelJob(jobId: string, user: PortalUser, allUsers = false): Promise<AiJob | null> {
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

  private async run(jobId: string, conversationId: string, question: string) {
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

      const conversation = this.conversations.get(conversationId);
      if (!conversation) throw new Error("Conversation not found");

      if (!conversation.project) {
        const chosen = await this.classifyProject(jobId, question, signal);
        this.patchConversation(conversationId, { project: chosen });
        this.patch(jobId, { project: chosen });
      }
      const project = conversation.project!;

      const repoUrl = config.ai.projects[project]?.repoUrl;
      if (!repoUrl) throw new Error(`Unknown project "${project}"`);
      const cloneDir = this.cloneDirFor(project);

      if (!(await pathExists(cloneDir))) {
        this.appendLog(jobId, `Cloning ${project} ...`);
        await mkdir(dirname(cloneDir), { recursive: true });
        await this.runCli(
          jobId,
          "git",
          ["clone", "--depth", "1", authenticatedRepoUrl(repoUrl), cloneDir],
          undefined,
          signal
        );
      } else {
        // Every question re-pulls — a plain `git pull` can choke on a shallow
        // (--depth 1) history, so fetch + hard-reset instead.
        this.appendLog(jobId, `Refreshing ${project} ...`);
        await this.runCli(jobId, "git", ["fetch", "--depth", "1", "origin"], cloneDir, signal);
        await this.runCli(jobId, "git", ["reset", "--hard", "origin/HEAD"], cloneDir, signal);
      }

      // Only on the first question of a conversation: the skill tool's output
      // (the SKILL.md body — how this project wants to be worked with) lands
      // in the opencode session transcript, so a continuing --session already
      // has it and re-loading would just waste a turn.
      const prompt = conversation.opencodeSessionId
        ? question
        : `Use the ai-${project} skill, then answer: ${question}`;

      this.appendLog(jobId, "Asking opencode ...");
      const { answer, thinking, sessionId } = await this.askOpencode(
        jobId,
        cloneDir,
        prompt,
        conversation.opencodeSessionId,
        signal
      );

      if (!conversation.opencodeSessionId && sessionId) {
        this.patchConversation(conversationId, { opencodeSessionId: sessionId });
      }

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
    existingSessionId: string | undefined,
    signal: AbortSignal
  ): Promise<{ answer: string; thinking?: string; sessionId?: string }> {
    // opencode resolves provider credentials from a PROVIDER_API_KEY env var,
    // e.g. anthropic/claude-sonnet-5 -> ANTHROPIC_API_KEY.
    const envVar = `${providerOf(config.ai.model).toUpperCase()}_API_KEY`;
    const env = {
      ...process.env,
      [envVar]: config.ai.apiKey,
      // Highest-precedence config — carries the read-only deny-list, so this
      // never depends on a file existing at opencode's default config path.
      OPENCODE_CONFIG: OPENCODE_CONFIG_PATH,
    };
    this.appendLog(
      jobId,
      `$ opencode run --dir ${cwd} --model ${config.ai.model}` +
        (existingSessionId ? ` --session ${existingSessionId}` : "") +
        ` --format json "<question>"`
    );

    // --format json: every event carries sessionID (continuity) and tool_use
    // events give a structured trace instead of scraping ANSI terminal text.
    // Confirmed empirically: all JSON events land on stdout, stderr is empty.
    //
    // spawn, not execFile: reading stdout as data arrives lets the job's
    // "thinking" grow across polls instead of only appearing once the whole
    // process exits.
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
          [
            "-c",
            'opencode run --dir "$R_DIR" --model "$R_MODEL" --auto --format json' +
              (existingSessionId ? ' --session "$R_SESSION"' : "") +
              ' "$R_QUESTION" < /dev/null',
          ],
          { ...env, R_DIR: cwd, R_MODEL: config.ai.model, R_QUESTION: question, R_SESSION: existingSessionId ?? "" },
        ]
      : ([
          "opencode",
          [
            "run",
            "--dir", cwd,
            "--model", config.ai.model,
            "--auto",
            "--format", "json",
            ...(existingSessionId ? ["--session", existingSessionId] : []),
            question,
          ],
          env,
        ] as const);

    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env: spawnEnv, signal, stdio: ["ignore", "pipe", "pipe"] });
      let buffer = "";
      const thinkingLines: string[] = [];
      const answerParts: string[] = [];
      let sessionId: string | undefined;
      let stderrText = "";

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let event: OpencodeEvent;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (!sessionId && event.sessionID) sessionId = event.sessionID;
        if (event.type === "tool_use" && event.part?.tool) {
          const input = event.part.state?.input;
          thinkingLines.push(input ? `${event.part.tool} ${JSON.stringify(input)}` : event.part.tool);
          this.patch(jobId, { thinking: redactSecrets(thinkingLines.join("\n")) });
        } else if (event.type === "text" && event.part?.text) {
          answerParts.push(event.part.text);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrText += chunk;
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        reject(err.code === "ENOENT" ? new Error("opencode not found — ensure it is on PATH") : err);
      });
      child.on("close", (code) => {
        if (buffer.trim()) handleLine(buffer);
        if (code === 0) {
          resolve({
            answer: answerParts.join("").trim() || "(opencode returned no answer)",
            thinking: thinkingLines.length ? redactSecrets(thinkingLines.join("\n")) : undefined,
            sessionId,
          });
          return;
        }
        reject(new Error(stderrText.trim() || `opencode exited with code ${code}`));
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
