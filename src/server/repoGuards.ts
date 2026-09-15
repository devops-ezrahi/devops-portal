import { config } from "./config";

/**
 * The guards standing between a builder and a git repo it will clone or write
 * to, plus the one rule about which host may be handed a credential.
 *
 * They live here rather than in a module because two modules now point git at a
 * repository the *user* typed: the ArgoCD builder's values repo and the
 * Jenkinsfile builder's source repo. `modules/argocd/valuesRepo.ts` is where
 * they were written and still re-exports them, so its own callers and tests
 * keep the names they had; `safeTreePath` stays there, because a `.yaml` suffix
 * is that module's rule and nobody else's.
 */

/** A git ref or repo subdirectory: no leading dash, no shell, no traversal. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * A repo URL the portal is willing to clone.
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

/** A repo subdirectory — the same rules, minus any file suffix. */
export function safeDirPath(path: string): boolean {
  if (!path) return true; // the repo root
  return REF_RE.test(path) && path.split("/").every(segmentOk);
}

/**
 * A path the portal will read or write inside a clone.
 *
 * The `.git` rule is the sharp one: a file written to `.git/hooks/pre-commit`
 * or `.git/config` (`core.fsmonitor`) is executed by the *very next* git
 * command in the same request. Everything else here keeps a path inside the
 * worktree; this one keeps it out of the repository's own machinery.
 *
 * This is the readable half of the check. The guarantee is the `resolve()`
 * containment test at each write site — a regex is an argument about a string,
 * and the filesystem gets the last word.
 *
 * No extension is required: the file this was added for is called `Jenkinsfile`
 * and usually has none. `safeTreePath` is the ArgoCD module's stricter variant.
 */
export function safeFilePath(path: string): boolean {
  if (!path || path.length > 200) return false;
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(path)) return false;
  return path.split("/").every(segmentOk);
}

function segmentOk(segment: string): boolean {
  // An empty segment is `a//b`; `.git` is the executable one; `..` is traversal.
  return segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git";
}

/**
 * Credential for *this* host, or nothing.
 *
 * Mirrors artifactory's `sourceTokenFor`: a repo on the same host as GIT_URL
 * reuses the organisation's git credential, anything else falls back to
 * whatever the calling module was given (ArgoCD passes ARGOCD_VALUES_TOKEN; the
 * Jenkinsfile builder passes nothing, because a Jenkinsfile lives in the very
 * repos GIT_URL already names), and an unrecognised host clones anonymously.
 *
 * The host match is the control, not a convenience. Without it, editing a repo
 * URL to any hostname is enough to have the server hand that host the
 * organisation's git token.
 */
export function tokenFor(repoUrl: string, fallbackToken = ""): { token: string; username: string } {
  const host = hostOf(repoUrl);
  if (!host) return { token: "", username: "" };
  if (config.git.enabled && hostOf(config.git.url) === host)
    return { token: config.git.token, username: config.git.username };
  if (fallbackToken) return { token: fallbackToken, username: "" };
  return { token: "", username: "" };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
