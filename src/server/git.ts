import { execFile } from "child_process";
import { promisify } from "util";
import { redactSecrets } from "./redact";
import { tokenFor } from "./repoGuards";

const execFileAsync = promisify(execFile);

/**
 * The one place a credential is put into a clone URL, and the one place git is
 * invoked outside a job.
 *
 * The job-running modules keep their own `runCli`: both are wired to a job's
 * `appendLog` and `AbortController`, and this path has neither — an ArgoCD pull
 * or push is one request, a couple of seconds, with nothing to stream or stop.
 */

/**
 * A credential in an http(s) clone URL. A non-http URL (`git@host:org/repo.git`
 * authenticates via the machine's own SSH key), an unparseable one, or an empty
 * token all come back untouched — a public repo still clones.
 */
export function withCredentials(repoUrl: string, token: string, username = ""): string {
  if (!token) return repoUrl;
  let u: URL;
  try {
    u = new URL(repoUrl);
  } catch {
    return repoUrl;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return repoUrl;
  if (username) {
    u.username = username;
    u.password = token;
  } else {
    u.username = token;
  }
  return u.toString();
}

/**
 * The GIT_URL/GIT_TOKEN form, for the AI module's registered repos. Re-exported
 * from there so its own callers and test keep the name they had. Only a repo on
 * the `GIT_URL` host gets the token (`tokenFor`) — any other host clones
 * anonymously rather than being handed the organisation's credential.
 */
export function authenticatedRepoUrl(repoUrl: string): string {
  const { token, username } = tokenFor(repoUrl);
  return withCredentials(repoUrl, token, username);
}

/** The branch a remote's HEAD points at — `master` on many a Bitbucket repo — or "" when it will not say. */
export async function defaultBranch(authedUrl: string): Promise<string> {
  const out = await git(["ls-remote", "--symref", "--", authedUrl, "HEAD"]).catch(() => "");
  return /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(out)?.[1] ?? "";
}

/**
 * A shallow clone of `revision`, and the branch that was actually cloned.
 *
 * Every builder pre-fills `main`, and plenty of repos — most Bitbucket ones —
 * are on `master`. A branch the remote does not have is therefore retried on
 * the remote's own default rather than failed; the caller hands the answer
 * back so the field says what was really read.
 */
export async function cloneAt(authedUrl: string, revision: string, dir: string, timeoutMs?: number): Promise<string> {
  try {
    await git(["clone", "--depth", "1", "--branch", revision, "--", authedUrl, dir], undefined, timeoutMs);
    return revision;
  } catch (err) {
    if (!/Remote branch .* not found/i.test(err instanceof Error ? err.message : "")) throw err;
    const head = await defaultBranch(authedUrl);
    if (!head || head === revision) throw err;
    await git(["clone", "--depth", "1", "--branch", head, "--", authedUrl, dir], undefined, timeoutMs);
    return head;
  }
}

/**
 * One git invocation.
 *
 * Two things here are load-bearing rather than tidy:
 *
 * - `GIT_TERMINAL_PROMPT=0`. The pull path deliberately allows an anonymous
 *   clone, so it *will* meet repos it cannot read. Without it, git prompts on a
 *   stdin nobody is holding and the request hangs until the timeout instead of
 *   failing in a few hundred milliseconds.
 * - `redactSecrets` on the thrown message. The job modules throw raw and rely on
 *   `appendLog` to scrub; this message travels through the HTTP error handler
 *   and onto the user's screen, and git quotes the remote — credential and all —
 *   in every authentication failure.
 */
export async function git(args: string[], cwd?: string, timeoutMs = 60_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
    });
    return stdout;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === "ENOENT") throw new Error("git not found — ensure it is on PATH");
    const detail = [e.stderr, e.stdout, e.message].find(Boolean) ?? "git command failed";
    throw new Error(redactSecrets(detail.toString().trim()));
  }
}
