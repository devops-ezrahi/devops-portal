import { BitbucketApi, BitbucketError } from "./bitbucket";
import { githubRepo, openGithubPullRequest } from "./github";
import { log } from "./log";

/**
 * Open a pull request on whichever host the repo lives on — GitHub or
 * Bitbucket Server — for the builders that commit to git (Jenkinsfile, ArgoCD).
 * Whitening drives `BitbucketApi` itself, since it knows project/repo already.
 */

export type BitbucketRepo = { baseUrl: string; project: string; repo: string };

/**
 * `<base>/scm/<project>/<repo>(.git)` — Bitbucket Server's clone URL. The REST
 * API sits under the same `<base>`, so a context path (`/bitbucket/scm/…`) is
 * kept rather than assumed away.
 */
export function bitbucketRepo(repoUrl: string): BitbucketRepo | null {
  let u: URL;
  try {
    u = new URL(repoUrl);
  } catch {
    return null;
  }
  const m = /^(.*?)\/scm\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u.pathname);
  if (!m) return null;
  return { baseUrl: `${u.protocol}//${u.host}${m[1]}`, project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };
}

export const canOpenPullRequest = (repoUrl: string): boolean => !!githubRepo(repoUrl) || !!bitbucketRepo(repoUrl);

/**
 * Open a PR, or hand back the one already open from `head` — the branch is per
 * document and force-pushed, so a second press is normal. `token` is the one
 * the caller already cloned and pushed with, so it only ever reaches that host.
 */
export async function openPullRequest(
  repoUrl: string,
  token: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<string> {
  if (githubRepo(repoUrl)) return openGithubPullRequest(repoUrl, token, head, base, title, body);

  const bb = bitbucketRepo(repoUrl);
  if (!bb) throw new Error(`Pull requests are only opened on GitHub or Bitbucket: ${repoUrl}`);
  const api = new BitbucketApi({ url: bb.baseUrl, token, username: "" });
  try {
    return await api.createPullRequest(bb.project, bb.repo, head, base, title, body);
  } catch (err) {
    // 409 = a PR from this branch is already open — the same case Whitening reuses.
    if (!(err instanceof BitbucketError) || err.status !== 409) throw err;
    const existing = await api.findOpenPullRequest(bb.project, bb.repo, head);
    if (!existing) throw err;
    log.info("git", "pull request already open", { branch: head, url: existing });
    return existing;
  }
}
