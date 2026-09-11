import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { dirname, join, resolve, sep } from "path";
import { git, withCredentials } from "../../git";
import { githubRepo, openPullRequest } from "../../github";
import { log } from "../../log";
import { safeFilePath, tokenFor } from "../../repoGuards";
import { createTmpDir, removeTmpDir } from "../../tmp";
import type { JenkinsfilePipeline } from "../../types";

/**
 * The source repo a pipeline came from, read and written.
 *
 * This is `modules/argocd/valuesGit.ts` with one file instead of a tree, and
 * deliberately the same shape down to the per-document force-pushed branch —
 * two builders that commit to git should not have two different ideas of what
 * pressing Commit does. Not a job, for the same reason: a shallow clone, one
 * small file, a commit and a push are a couple of seconds, so it is one
 * request with one timeout and no history to keep.
 *
 * What is genuinely different is the *read*. ArgoCD is pointed at a directory
 * and takes everything in it; here there is one file, its name is a convention
 * rather than a rule, and nobody wants to type the path of the file they are
 * about to import. So the repo is searched — see `pickJenkinsfile`.
 */

/** A repo is searched, not walked: a monorepo would otherwise be read whole. */
const MAX_ENTRIES = 4000;
const MAX_DEPTH = 4;
/** Matches the router's own cap on the text a push may carry. */
const MAX_TEXT = 256_000;

/** Directories never worth descending into, in any repository. */
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "target", "dist", "build", ".gradle", ".idea"]);

/**
 * `Jenkinsfile`, `Jenkinsfile.release`, `deploy.jenkinsfile` — the three shapes
 * in the wild. Case-insensitive because Windows checkouts and tired people.
 */
export function isJenkinsfileName(basename: string): boolean {
  return /^Jenkinsfile(\.[A-Za-z0-9._-]+)?$/i.test(basename) || /\.jenkinsfile$/i.test(basename);
}

export type Pick = { path: string; candidates: string[]; problem?: string };

/**
 * Which of the repo's files is *the* Jenkinsfile.
 *
 * A repo root `Jenkinsfile` wins outright — that is what "the Jenkinsfile"
 * means, and a repo that also ships `ci/Jenkinsfile.nightly` still has one
 * obvious answer. Failing that, a single candidate anywhere is taken.
 *
 * **Several is a question, not a guess.** Picking the shallowest or the
 * alphabetically first would import the wrong pipeline silently and then commit
 * over it, which is the one failure mode worth a click to avoid — so it comes
 * back as a problem naming them, and the dialog's path field is where the
 * answer goes. None is the same sentence in the other direction. Neither needs
 * a picker component: the field is already on screen.
 */
export function pickJenkinsfile(paths: string[]): Pick {
  const candidates = paths.filter((p) => isJenkinsfileName(p.split("/").pop() ?? "")).sort();
  const atRoot = candidates.find((p) => p.toLowerCase() === "jenkinsfile");
  if (atRoot) return { path: atRoot, candidates };
  if (candidates.length === 1) return { path: candidates[0], candidates };
  if (!candidates.length)
    return {
      path: "",
      candidates,
      problem: "No Jenkinsfile in that repository. If it is called something else, type its path below.",
    };
  return {
    path: "",
    candidates,
    problem: `That repository has ${candidates.length} Jenkinsfiles — ${candidates
      .slice(0, 8)
      .join(", ")}${candidates.length > 8 ? ", …" : ""}. Type the path of the one you want below.`,
  };
}

/** Every file under `dir`, as forward-slash paths relative to it. Bounded. */
async function listFiles(dir: string, prefix = "", depth = 0, budget = { left: MAX_ENTRIES }): Promise<string[]> {
  if (depth > MAX_DEPTH || budget.left <= 0) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (budget.left-- <= 0) break;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel, depth + 1, budget)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * The last word on where a file may be read or written. `safeFilePath` is the
 * readable rule; this is the one the filesystem enforces, after every `..`,
 * symlink and separator has been resolved.
 */
function inside(root: string, full: string): boolean {
  return resolve(full).startsWith(resolve(root) + sep);
}

/**
 * Found, or a sentence saying why not.
 *
 * "No Jenkinsfile" and "several Jenkinsfiles" are ordinary answers about a
 * repository, not faults, so they come back as a value the route turns into a
 * 404 — rather than as an exception the route would have to recognise by
 * pattern-matching its own message.
 */
export type PullResult =
  | { path: string; text: string; candidates: string[] }
  | { problem: string; candidates: string[] };

/**
 * Clone a repo and read its Jenkinsfile out of it.
 *
 * The text comes back raw: turning it into stages is `parse.ts`'s job, in the
 * browser, where the catalog and the whole warnings apparatus already live.
 * Parsing it here would fork the importer the New dialog already uses.
 *
 * `wanted` is the path the user typed, or `""` to have the repo searched.
 */
export async function pullJenkinsfile(repoUrl: string, revision: string, wanted: string): Promise<PullResult> {
  const dir = await createTmpDir("jf-");
  try {
    const { token, username } = tokenFor(repoUrl);
    await git(["clone", "--depth", "1", "--branch", revision, "--", withCredentials(repoUrl, token, username), dir]);

    const chosen = wanted ? { path: wanted, candidates: [wanted], problem: "" } : pickJenkinsfile(await listFiles(dir));
    if (!chosen.path) return { problem: chosen.problem ?? "No Jenkinsfile in that repository.", candidates: chosen.candidates };

    const full = join(dir, chosen.path);
    // Unreachable through the route, which validates the path first — but this
    // is the function that opens the handle, and tests call it directly.
    if (!safeFilePath(chosen.path) || !inside(dir, full))
      throw new Error(`Refusing to read outside the repository: ${chosen.path}`);

    let text: string;
    try {
      text = await readFile(full, "utf8");
    } catch {
      // Only reachable for a hand-typed path: a searched one was just listed.
      return { problem: `There is no ${chosen.path} on ${revision} in that repository.`, candidates: chosen.candidates };
    }
    if (text.length > MAX_TEXT)
      return { problem: `${chosen.path} is larger than ${MAX_TEXT / 1000} KB.`, candidates: chosen.candidates };

    log.info("jenkinsfile", `pulled ${chosen.path}`, { repoUrl, revision, bytes: text.length });
    return { path: chosen.path, text, candidates: chosen.candidates };
  } finally {
    await removeTmpDir(dir);
  }
}

export type PushResult = { branch: string; changed: boolean; prUrl: string; note?: string };

/**
 * Write the generated Jenkinsfile onto a branch of its repo and open a PR.
 *
 * The branch is per **pipeline**, not per push, and force-pushed: pressing the
 * button twice must update one pull request, not open a second.
 */
export async function pushJenkinsfile(opts: {
  pipeline: JenkinsfilePipeline;
  text: string;
  branch: string;
  message: string;
  authorName: string;
}): Promise<PushResult> {
  const { pipeline, text, branch, message, authorName } = opts;
  const repo = pipeline.repo!;
  const path = repo.path;
  const { token, username } = tokenFor(repo.repoUrl);
  const dir = await createTmpDir("jf-");

  try {
    await git([
      "clone",
      "--depth",
      "1",
      "--branch",
      repo.revision,
      "--",
      withCredentials(repo.repoUrl, token, username),
      dir,
    ]);

    // Continue this pipeline's branch if the remote already has one, rather
    // than rebuilding it from the base branch. The clone is of `revision`, so
    // `checkout -B <branch>` alone would branch off base every time — and the
    // same file committed again would then always read as a change, which
    // turns "pressing Commit twice updates one pull request" into a new commit
    // per press and makes "nothing to commit" unreachable. A branch that is not
    // there yet is the normal first push, so the failure is expected and quiet.
    const existing = await git(["fetch", "--depth", "1", "origin", branch], dir).then(
      () => true,
      () => false
    );
    await git(["checkout", "-B", branch, existing ? "FETCH_HEAD" : "HEAD"], dir);

    // Checked at the route as well; repeated here because this is the function
    // that actually opens a handle, and it is called from tests directly.
    if (!safeFilePath(path)) throw new Error(`Refusing to write ${path}`);
    const full = join(dir, path);
    if (!inside(dir, full)) throw new Error(`Refusing to write outside the repository: ${path}`);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text, "utf8");

    await git(["add", "-A", "--", path], dir);
    const staged = (await git(["diff", "--cached", "--name-only"], dir)).trim();
    if (!staged) {
      log.info("jenkinsfile", `nothing to push for ${pipeline.id}`, { branch });
      return { branch, changed: false, prUrl: "" };
    }

    await git(
      [
        "-c",
        "user.email=jenkinsfile@devops-portal",
        "-c",
        `user.name=${authorName || "DevOps Portal"}`,
        "commit",
        "-m",
        message,
      ],
      dir
    );
    await git(["push", "--force", "origin", `HEAD:${branch}`], dir, 120_000);
    log.info("jenkinsfile", `pushed ${pipeline.id}`, { branch, path });

    if (!githubRepo(repo.repoUrl))
      return {
        branch,
        changed: true,
        prUrl: "",
        note: `Pushed to ${branch}. Pull requests can only be opened on GitHub from here — open this one by hand.`,
      };

    const prUrl = await openPullRequest(repo.repoUrl, token, branch, repo.revision, message, prBody(pipeline, path));
    return { branch, changed: true, prUrl };
  } finally {
    await removeTmpDir(dir);
  }
}

function prBody(pipeline: JenkinsfilePipeline, path: string): string {
  return [
    `Generated by the DevOps Portal's Jenkinsfile builder from pipeline \`${pipeline.id}\` (${pipeline.name}).`,
    "",
    `- File: \`${path}\``,
    `- Stages: ${pipeline.stages.map((s) => s.step).join(", ") || "none"}`,
    pipeline.library ? `- Library: \`${pipeline.library}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
