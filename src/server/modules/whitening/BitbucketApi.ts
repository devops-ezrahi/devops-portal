import { describeError, log } from "../../log";

export type BitbucketConfig = {
  url: string;
  token: string;
  username: string;
};

type BitbucketBranch = {
  displayId: string;
};

type BitbucketPullRequest = {
  links?: { self?: { href: string }[] };
};

type BitbucketPage<T> = {
  values?: T[];
};

/** Thrown for non-2xx responses so callers can branch on the status. */
export class BitbucketError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function prUrl(pr: BitbucketPullRequest): string {
  return pr.links?.self?.[0]?.href ?? "";
}

/**
 * Bitbucket Server / Data Center REST client.
 *
 * The pack's `team` is the Bitbucket **project key** and `repository` is the repo
 * slug, so every path is `/projects/{key}/repos/{slug}`.
 */
export class BitbucketApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly username: string;

  constructor(config: BitbucketConfig) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.token = config.token;
    this.username = config.username;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/rest/api/1.0${path}`;
    const method = (options.method ?? "GET").toUpperCase();
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(options.headers ?? {}),
        },
      });
    } catch (cause) {
      log.error("bitbucket", `${method} ${path} unreachable`, cause, { ms: Date.now() - started, url });
      throw new BitbucketError(`Bitbucket request failed: could not reach ${url} (${describeError(cause)})`, 0);
    }

    const ms = Date.now() - started;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      log.warn("bitbucket", `${method} ${path} ${response.status} ${response.statusText}`, {
        ms,
        body: body.trim().slice(0, 500) || undefined,
      });
      throw new BitbucketError(
        `Bitbucket request failed: ${response.status} ${response.statusText} ${body}`.trim(),
        response.status
      );
    }
    log.debug("bitbucket", `${method} ${path} ${response.status}`, { ms });

    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private static repoPath(project: string, repo: string) {
    return `/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}`;
  }

  /** Probe before cloning, so a wrong project/repo fails fast with a clear message. */
  async repoExists(project: string, repo: string): Promise<boolean> {
    try {
      await this.request(BitbucketApi.repoPath(project, repo));
      return true;
    } catch (err) {
      if (err instanceof BitbucketError && err.status === 404) return false;
      throw err;
    }
  }

  async getDefaultBranch(project: string, repo: string): Promise<string> {
    const branch = await this.request<BitbucketBranch>(
      `${BitbucketApi.repoPath(project, repo)}/branches/default`
    );
    return branch.displayId;
  }

  async createPullRequest(
    project: string,
    repo: string,
    fromBranch: string,
    toBranch: string,
    title: string,
    description: string
  ): Promise<string> {
    const pr = await this.request<BitbucketPullRequest>(
      `${BitbucketApi.repoPath(project, repo)}/pull-requests`,
      {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          fromRef: { id: `refs/heads/${fromBranch}` },
          toRef: { id: `refs/heads/${toBranch}` },
        }),
      }
    );
    return prUrl(pr);
  }

  /** The open PR already raised from `fromBranch`, if any — used to reuse instead of 409. */
  async findOpenPullRequest(project: string, repo: string, fromBranch: string): Promise<string | null> {
    const query = `?direction=OUTGOING&state=OPEN&at=${encodeURIComponent(`refs/heads/${fromBranch}`)}`;
    const page = await this.request<BitbucketPage<BitbucketPullRequest>>(
      `${BitbucketApi.repoPath(project, repo)}/pull-requests${query}`
    );
    const found = page.values?.[0];
    return found ? prUrl(found) : null;
  }

  /**
   * Embeds the token so `git push` needs no separate credential helper. Bitbucket
   * serves the git protocol under /scm/ (the REST API is at /rest/api/1.0).
   *
   * With no GIT_USERNAME the HTTP access token goes in alone, which is Bitbucket's
   * documented token form; set GIT_USERNAME only if your instance wants basic auth.
   */
  authenticatedCloneUrl(project: string, repo: string): string {
    const u = new URL(this.baseUrl);
    if (this.username) {
      u.username = this.username;
      u.password = this.token;
    } else {
      u.username = this.token;
    }
    return `${u.toString().replace(/\/+$/, "")}/scm/${project}/${repo}.git`;
  }
}
