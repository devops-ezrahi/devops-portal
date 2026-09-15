import { log } from "./log";

/**
 * Just enough GitHub to open one pull request.
 *
 * Whitening's `BitbucketApi` cannot serve here — it speaks Bitbucket Server's
 * `/rest/api/1.0/` and builds `/scm/<project>/<repo>.git` clone URLs — and a
 * `PrHost` interface over the two would be an abstraction with one real
 * implementation on each side. So this is a second small client, and the
 * dispatch is one `if` in the router.
 */

export type GithubRepo = { apiBase: string; owner: string; repo: string };

/**
 * `owner`/`repo` and the API root, or null when the URL is not GitHub.
 *
 * ponytail: github.com only. A GitHub Enterprise host would be the same client
 * against `https://<host>/api/v3` — add that branch when there is one to test
 * against, rather than guessing which hostnames are GHE.
 */
export function githubRepo(repoUrl: string): GithubRepo | null {
  let u: URL;
  try {
    u = new URL(repoUrl);
  } catch {
    return null;
  }
  if (u.host.toLowerCase().replace(/^www\./, "") !== "github.com") return null;
  const [owner, repo, ...rest] = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
  if (!owner || !repo || rest.length) return null;
  return { apiBase: "https://api.github.com", owner, repo };
}

async function api(
  repo: GithubRepo,
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${repo.apiBase}/repos/${repo.owner}/${repo.repo}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* a proxy's HTML error page — keep the text, it is what the message needs */
  }
  return { status: res.status, body };
}

/**
 * Open a PR, or hand back the one that is already open.
 *
 * The branch is per tree and force-pushed, so pressing the button twice is
 * normal and must not be an error. GitHub answers the second create with a 422
 * naming the existing PR — the direct analogue of the Bitbucket 409 the
 * whitening module already handles this way.
 */
export async function openPullRequest(
  repoUrl: string,
  token: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<string> {
  const repo = githubRepo(repoUrl);
  if (!repo) throw new Error(`Not a GitHub repository URL: ${repoUrl}`);

  const created = await api(repo, token, "/pulls", {
    method: "POST",
    body: JSON.stringify({ title, head, base, body }),
  });
  if (created.status === 201) return urlOf(created.body) ?? "";

  if (created.status === 422) {
    const open = await api(repo, token, `/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${head}`)}`);
    const existing = Array.isArray(open.body) ? urlOf(open.body[0]) : null;
    if (existing) {
      log.info("argocd", "pull request already open", { branch: head, url: existing });
      return existing;
    }
  }
  throw new Error(`GitHub refused the pull request (${created.status}): ${messageOf(created.body)}`);
}

function urlOf(body: unknown): string | null {
  const url = (body as { html_url?: unknown } | null)?.html_url;
  return typeof url === "string" ? url : null;
}

function messageOf(body: unknown): string {
  const b = body as { message?: unknown; errors?: { message?: unknown }[] } | null;
  const detail = b?.errors?.map((e) => e?.message).filter(Boolean).join("; ");
  return [typeof b?.message === "string" ? b.message : "", detail].filter(Boolean).join(" — ") || String(body);
}
