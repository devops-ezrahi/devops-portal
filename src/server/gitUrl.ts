/**
 * SSH clone URLs, rewritten to the HTTPS form.
 *
 * People paste whatever their git host's "Clone" button gave them, and for most
 * of them that is SSH. The portal cannot use it: it holds no SSH key, only
 * tokens, and `safeRepoUrl` allows http(s) alone. So the URL is rewritten rather
 * than refused.
 *
 * This file has **no imports on purpose**: it is the one module the browser and
 * the server both run, so the field can show the rewrite as you type and the
 * server can apply the same rule to anything that reaches it by another route.
 * Adding an import here (config, node builtins) breaks the client bundle.
 *
 * Anything that is not recognisably an SSH clone URL is returned untouched —
 * including nonsense. This normalises; `safeRepoUrl` is what refuses.
 */

/** `git@host:org/repo.git` — the scp-like form, which is not a URL at all. */
const SCP_LIKE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/)(.+)$/;

/**
 * The cloud hosts serve SSH and HTTPS on the same path. Anything else is taken
 * to be Bitbucket Server, whose HTTPS clone path is `/scm/<project>/<repo>.git`
 * while its SSH one is `/<project>/<repo>.git` — dropping the `/scm/` gives a
 * URL that 404s.
 *
 * ponytail: every non-cloud host is assumed Bitbucket. A self-hosted GitLab or
 * Gitea would need its hostname listed here.
 */
const SAME_PATH_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];

/**
 * `GIT_URL` split into the host an SSH URL names and the HTTPS base it lives
 * under — a Bitbucket Server often serves HTTP on its own port (`:7990`) and
 * under a context path (`/bitbucket`), neither of which an SSH URL carries.
 */
function homeOf(gitUrl: string): { hostname: string; base: string } | null {
  try {
    const u = new URL(gitUrl.trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    return { hostname: u.hostname.toLowerCase(), base: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}` };
  } catch {
    return null;
  }
}

function httpsOf(host: string, path: string, gitUrl: string): string {
  const clean = path.replace(/^\/+/, "");
  const home = homeOf(gitUrl);
  // The portal's own Bitbucket: rebuilt on GIT_URL, so the port and context
  // path come back and the host still matches the one the token is tied to.
  if (home && home.hostname === host.toLowerCase()) return `${home.base}/${/^scm\//i.test(clean) ? "" : "scm/"}${clean}`;
  const scm = SAME_PATH_HOSTS.includes(host.toLowerCase()) || /^scm\//i.test(clean) ? "" : "scm/";
  return `https://${host}/${scm}${clean}`;
}

/** `gitUrl` is the portal's `GIT_URL`, when the caller knows it — see `homeOf`. */
export function normalizeRepoUrl(url: string, gitUrl = ""): string {
  const trimmed = url.trim();
  if (!trimmed) return "";

  const scp = SCP_LIKE.exec(trimmed);
  if (scp) return httpsOf(scp[2], scp[3], gitUrl);

  if (/^ssh:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      // The SSH port is dropped, not carried over: an SSH port is not an HTTPS
      // one (Bitbucket Server's 7999 against 7990/443). The HTTPS one, if any,
      // comes from GIT_URL.
      return `${httpsOf(u.hostname, u.pathname, gitUrl)}${u.search}`;
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

/**
 * The placeholder a repo field shows: a clone URL on the portal's own
 * `GIT_URL` (Bitbucket Server) when one is configured, since that is where the
 * repos usually are; github.com only when nothing says otherwise.
 */
export function exampleRepoUrl(gitUrl: string, repo: string): string {
  const base = gitUrl.trim().replace(/\/+$/, "");
  return base ? `${base}/scm/project/${repo}.git` : `https://github.com/org/${repo}.git`;
}

/** Whether `normalizeRepoUrl` would change this — what the field says out loud. */
export function isSshUrl(url: string): boolean {
  const trimmed = url.trim();
  return !!trimmed && normalizeRepoUrl(trimmed) !== trimmed;
}

/**
 * The page a person opens for a clone URL: the repo (at `revision`), or a
 * directory / file in it. GitHub, GitLab, bitbucket.org and Bitbucket Server
 * (`/scm/PROJ/repo.git`) each spell it differently. Never carries credentials —
 * only the host and path are kept. "" when the URL is not http(s).
 */
export function repoWebUrl(repoUrl: string, revision = "", path = "", file = false): string {
  let u: URL;
  try {
    u = new URL(normalizeRepoUrl(repoUrl));
  } catch {
    return "";
  }
  if (!/^https?:$/.test(u.protocol)) return "";
  const base = `${u.protocol}//${u.host}`;
  const repo = u.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  const rev = revision.trim();
  const sub = path.trim().replace(/^\.?\/+|\/+$/g, "").replace(/^\.$/, "");
  // Not anchored at the start: a Bitbucket Server under a context path clones
  // from `/bitbucket/scm/P/r.git` and browses from `/bitbucket/projects/P/…`.
  const scm = /^(.*?)\/scm\/([^/]+)\/([^/]+)$/.exec(repo);
  if (scm)
    return `${base}${scm[1]}/projects/${scm[2]}/repos/${scm[3]}/browse${sub ? `/${sub}` : ""}${rev ? `?at=${encodeURIComponent(rev)}` : ""}`;
  if (!rev && !sub) return `${base}${repo}`;
  if (u.hostname === "bitbucket.org") return `${base}${repo}/src/${rev || "HEAD"}${sub ? `/${sub}` : ""}`;
  const gitlab = u.hostname.includes("gitlab") ? "/-" : "";
  return `${base}${repo}${gitlab}/${file && sub ? "blob" : "tree"}/${rev || "HEAD"}${sub ? `/${sub}` : ""}`;
}
