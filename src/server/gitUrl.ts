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

/** Whether `normalizeRepoUrl` would change this — what the field says out loud. */
export function isSshUrl(url: string): boolean {
  const trimmed = url.trim();
  return !!trimmed && normalizeRepoUrl(trimmed) !== trimmed;
}
