import { config } from "../../config";

/**
 * The two guards standing between the builder and a git repo it can write to.
 *
 * Both exist because the destination is *user-editable*: `values.repoUrl` is a
 * free-text field in the Repositories panel, and the pushed file list is
 * generated in the browser. Neither can be trusted the way a config value can.
 */

/** A git ref or repo subdirectory: no leading dash, no shell, no traversal. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Credential for *this* host, or nothing.
 *
 * Mirrors artifactory's `sourceTokenFor`: a values repo on the same host as
 * GIT_URL reuses the Bitbucket credential and needs no new variable, anything
 * else needs ARGOCD_VALUES_TOKEN, and an unrecognised host clones anonymously.
 *
 * The host match is the control, not a convenience. Without it, editing
 * `values.repoUrl` to any hostname is enough to have the server hand that host
 * the organisation's git token.
 */
export function valuesTokenFor(repoUrl: string): { token: string; username: string } {
  const host = hostOf(repoUrl);
  if (!host) return { token: "", username: "" };
  if (config.git.enabled && hostOf(config.git.url) === host)
    return { token: config.git.token, username: config.git.username };
  if (config.argocd.valuesToken) return { token: config.argocd.valuesToken, username: "" };
  return { token: "", username: "" };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A repo URL this module is willing to clone.
 *
 * http(s) only — which is what rules out `file://`, `ssh://`, and above all
 * git's `ext::` transport, whose "URL" is a shell command git runs.
 */
export function safeRepoUrl(url: string): boolean {
  if (url.startsWith("-")) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.host;
  } catch {
    return false;
  }
}

/** A branch name or revision. */
export function safeRef(ref: string): boolean {
  return REF_RE.test(ref) && !ref.includes("..") && ref.length <= 100;
}

/** A repo subdirectory (`values.path`) — the same rules, minus the file suffix. */
export function safeDirPath(path: string): boolean {
  if (!path) return true; // the tree lives at the repo root
  return REF_RE.test(path) && segments(path).every(ok);
}

/**
 * A path this module will write inside a clone.
 *
 * The `.git` rule is the sharp one: a file written to `.git/hooks/pre-commit`
 * or `.git/config` (`core.fsmonitor`) is executed by the *very next* git
 * command in the same request. Everything else here keeps a path inside the
 * worktree; this one keeps it out of the repository's own machinery.
 *
 * This is the readable half of the check. The guarantee is the `resolve()`
 * containment test at the write site — a regex is an argument about a string,
 * and the filesystem gets the last word.
 */
export function safeTreePath(path: string): boolean {
  if (!path.endsWith(".yaml") || path.length > 200) return false;
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(path)) return false;
  return segments(path).every(ok);
}

function segments(path: string): string[] {
  return path.split("/");
}

function ok(segment: string): boolean {
  // An empty segment is `a//b`; `.git` is the executable one; `..` is traversal.
  return segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git";
}
