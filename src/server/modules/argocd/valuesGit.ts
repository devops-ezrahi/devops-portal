import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { dirname, join, resolve, sep } from "path";
import { cloneAt, git, objectAt, withCredentials } from "../../git";
import { log } from "../../log";
import { createTmpDir, removeTmpDir } from "../../tmp";
import { canOpenPullRequest, openPullRequest } from "../../pullRequest";
import { safeTreePath, valuesTokenFor } from "./valuesRepo";
import type { ArgocdTree } from "../../types";

/**
 * The values repo, read and written.
 *
 * Deliberately *not* a job. Whitening runs a JobStore because it unpacks
 * ~127 MB and shells out to skopeo; a shallow clone of a values repo, a handful
 * of small YAML writes, a commit and a push take a couple of seconds. One
 * request, one timeout, no history to keep.
 *
 * The sequence is whitening's `pushSourceAndOpenPr`, minus the wipe — see
 * `writeFiles` for why that difference matters.
 */

export type RepoFile = { path: string; text: string };

const MAX_FILES = 500;
const MAX_BYTES = 2 * 1024 * 1024;

/** Where the tree sits inside the repo. `""` is the repo root. */
function treeRoot(repoDir: string, valuesPath: string): string {
  return valuesPath ? join(repoDir, valuesPath) : repoDir;
}

/**
 * The last word on where a file may be written. `safeTreePath` is the readable
 * rule; this is the one the filesystem enforces, after every `..`, symlink and
 * separator has been resolved.
 */
function inside(root: string, full: string): boolean {
  const base = resolve(root);
  return resolve(full).startsWith(base + sep);
}

/** Every file under `dir`, as forward-slash paths relative to it. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/**
 * A file the tree owns — the client's `isTreeFile` (`tree.ts`), repeated here
 * because the server does not import client modules. Keep the two in step.
 */
const NOT_NAMESPACES = ["cluster-shared", "ERRORS_ANALYSIS", "report"];
export function isTreeFile(path: string): boolean {
  if (NOT_NAMESPACES.includes(path.split("/")[0])) return false;
  return /^base\/.+\.yaml$/.test(path) || /^[^/].*\/defaults\.yaml$/.test(path) || /^[^/].*?\/values\/.+\.yaml$/.test(path);
}

/** Every `.yaml` under `dir`, as forward-slash paths relative to it. */
async function listYaml(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listYaml(join(dir, entry.name), rel)));
    else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) out.push(rel);
  }
  return out;
}

/**
 * Clone a values repo and read the tree out of it.
 *
 * Returns raw file text; reversing it into releases and namespaces is the
 * client's job, because the catalog, `importValues` and the whole warnings
 * apparatus already live there. Parsing it here would fork `import.ts`.
 */
export async function pullValuesTree(
  repoUrl: string,
  requested: string,
  valuesPath: string
): Promise<{ files: RepoFile[]; revision: string; sha: string }> {
  const dir = await createTmpDir("ag-");
  try {
    const { token, username } = valuesTokenFor(repoUrl);
    const revision = await cloneAt(withCredentials(repoUrl, token, username), requested, dir);
    const root = treeRoot(dir, valuesPath);
    const names = (await listYaml(root)).slice(0, MAX_FILES);
    let bytes = 0;
    const files: RepoFile[] = [];
    for (const name of names) {
      const full = join(root, name);
      if (!inside(root, full)) continue;
      const text = await readFile(full, "utf8");
      bytes += text.length;
      if (bytes > MAX_BYTES) break;
      files.push({ path: name, text });
    }
    const sha = await objectAt(dir, valuesPath);
    log.info("argocd", `pulled ${files.length} file(s)`, { repoUrl, revision, path: valuesPath || ".", sha });
    return { files, revision, sha };
  } finally {
    await removeTmpDir(dir);
  }
}

export type PushResult = { branch: string; changed: boolean; prUrl: string; note?: string };

/**
 * Write the generated tree onto a branch of the values repo and open a PR.
 *
 * The branch is per **tree**, not per push, and force-pushed: pressing the
 * button twice must update one pull request, not open a second.
 */
export async function pushValuesTree(opts: {
  tree: ArgocdTree;
  files: RepoFile[];
  branch: string;
  message: string;
  authorName: string;
}): Promise<PushResult> {
  const { tree, files, branch, message, authorName } = opts;
  const repoUrl = tree.values.repoUrl;
  const revision = tree.values.revision;
  const valuesPath = (tree.values.path ?? "").replace(/^\/+|\/+$/g, "");
  const { token, username } = valuesTokenFor(repoUrl);
  const dir = await createTmpDir("ag-");

  try {
    await git(["clone", "--depth", "1", "--branch", revision, "--", withCredentials(repoUrl, token, username), dir]);
    // Continue this tree's branch when the remote has one — `pushJenkinsfile`'s
    // rule. Rebuilt from `revision` every time, the same files always read as a
    // change, so "nothing to commit" was unreachable and each press churned the
    // PR. No branch yet is the normal first push, so that failure is quiet.
    const existing = await git(["fetch", "--depth", "1", "origin", branch], dir).then(
      () => true,
      () => false
    );
    await git(["checkout", "-B", branch, existing ? "FETCH_HEAD" : "HEAD"], dir);

    // ponytail: at the repo root this only writes, never deletes — a namespace
    // removed in the builder keeps its directory in the PR, because at the root
    // there is no way to tell this tree's directories from another tree's.
    // Set `values.path` to a subdirectory and deletes become exact — but only of
    // the tree's own files (base/**, <ns>/defaults.yaml, <ns>/values/**). Emptying
    // the whole folder also deleted its root ApplicationSet, a README, the
    // converter's input/ and report/: files the pull never read, so the preview
    // could not even show them going.
    if (valuesPath) {
      const root = treeRoot(dir, valuesPath);
      if (!inside(dir, root)) throw new Error(`Refusing to write outside the repository: ${valuesPath}`);
      const keep = new Set(files.map((f) => f.path));
      const stale = (await listFiles(root)).filter((p) => isTreeFile(p) && !keep.has(p));
      for (let i = 0; i < stale.length; i += 100)
        await git(["rm", "--ignore-unmatch", "--quiet", "--", ...stale.slice(i, i + 100).map((p) => `${valuesPath}/${p}`)], dir);
    }

    await writeFiles(dir, valuesPath, files);
    await git(["add", "-A", "--", valuesPath || "."], dir);

    const staged = (await git(["diff", "--cached", "--name-only"], dir)).trim();
    if (!staged) {
      log.info("argocd", `nothing to push for ${tree.id}`, { branch });
      return { branch, changed: false, prUrl: "" };
    }

    await git(
      [
        "-c",
        "user.email=argocd@devops-portal",
        "-c",
        `user.name=${authorName || "DevOps Portal"}`,
        "commit",
        "-m",
        message,
      ],
      dir
    );
    await git(["push", "--force", "origin", `HEAD:${branch}`], dir, 120_000);
    log.info("argocd", `pushed ${tree.id}`, { branch, files: staged.split("\n").length });

    if (!canOpenPullRequest(repoUrl))
      return {
        branch,
        changed: true,
        prUrl: "",
        note: `Pushed to ${branch}. Pull requests are only opened on GitHub or Bitbucket from here — open this one by hand.`,
      };

    const prUrl = await openPullRequest(repoUrl, token, branch, revision, message, prBody(tree, valuesPath, staged));
    return { branch, changed: true, prUrl };
  } finally {
    await removeTmpDir(dir);
  }
}

async function writeFiles(repoDir: string, valuesPath: string, files: RepoFile[]): Promise<void> {
  const root = treeRoot(repoDir, valuesPath);
  for (const file of files) {
    // Checked at the route as well; repeated here because this is the function
    // that actually opens a handle, and it is called from tests directly.
    if (!safeTreePath(file.path)) throw new Error(`Refusing to write ${file.path}`);
    const full = join(root, file.path);
    if (!inside(root, full)) throw new Error(`Refusing to write outside the tree: ${file.path}`);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, file.text, "utf8");
  }
}

function prBody(tree: ArgocdTree, valuesPath: string, staged: string): string {
  const lines = [
    `Generated by the DevOps Portal's ArgoCD builder from tree \`${tree.id}\` (${tree.name}).`,
    "",
    `- Chart: \`${tree.chart.repoUrl}\` @ \`${tree.chart.revision}\``,
    `- Releases: ${tree.releases.map((r) => r.name).filter(Boolean).join(", ") || "none"}`,
    `- Namespaces: ${tree.namespaces.map((n) => n.name).filter(Boolean).join(", ") || "none"}`,
    "",
    "```",
    staged,
    "```",
  ];
  if (!valuesPath)
    lines.push(
      "",
      "> This tree lives at the repository root, so the push only adds and updates files —",
      "> a namespace removed in the builder keeps its directory here and must be deleted by hand.",
      "> Point the tree at a subdirectory (`values.path`) to have removals travel too."
    );
  return lines.join("\n");
}
