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

function httpsOf(host: string, path: string): string {
  const clean = path.replace(/^\/+/, "");
  const scm = SAME_PATH_HOSTS.includes(host.toLowerCase()) || /^scm\//i.test(clean) ? "" : "scm/";
  return `https://${host}/${scm}${clean}`;
}

export function normalizeRepoUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";

  const scp = SCP_LIKE.exec(trimmed);
  if (scp) return httpsOf(scp[2], scp[3]);

  if (/^ssh:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      // The port is dropped, not carried over: an SSH port is not an HTTPS one
      // (Bitbucket Server's 7999 against 443), so keeping it would produce a
      // URL that certainly fails rather than one that probably works.
      return `${httpsOf(u.hostname, u.pathname)}${u.search}`;
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
  const scm = /^\/scm\/([^/]+)\/([^/]+)$/.exec(repo);
  if (scm)
    return `${base}/projects/${scm[1]}/repos/${scm[2]}/browse${sub ? `/${sub}` : ""}${rev ? `?at=${encodeURIComponent(rev)}` : ""}`;
  if (!rev && !sub) return `${base}${repo}`;
  if (u.hostname === "bitbucket.org") return `${base}${repo}/src/${rev || "HEAD"}${sub ? `/${sub}` : ""}`;
  const gitlab = u.hostname.includes("gitlab") ? "/-" : "";
  return `${base}${repo}${gitlab}/${file && sub ? "blob" : "tree"}/${rev || "HEAD"}${sub ? `/${sub}` : ""}`;
}
