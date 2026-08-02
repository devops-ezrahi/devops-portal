export type GiteaConfig = {
  url: string;
  token: string;
  username: string;
};

type GiteaRepo = {
  default_branch: string;
};

type GiteaPullRequest = {
  html_url: string;
};

export class GiteaApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly username: string;

  constructor(config: GiteaConfig) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.token = config.token;
    this.username = config.username;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v1${path}`, {
        ...options,
        headers: {
          Authorization: `token ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(options.headers ?? {}),
        },
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Gitea request failed: could not reach ${this.baseUrl}${path} (${reason})`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gitea request failed: ${response.status} ${response.statusText} ${body}`.trim());
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const info = await this.request<GiteaRepo>(`/repos/${owner}/${repo}`);
    return info.default_branch;
  }

  async createPullRequest(
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string
  ): Promise<GiteaPullRequest> {
    return this.request<GiteaPullRequest>(`/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ head, base, title, body }),
    });
  }

  // Embeds the token so `git push` needs no separate credential helper.
  authenticatedCloneUrl(owner: string, repo: string): string {
    const u = new URL(this.baseUrl);
    u.username = this.username;
    u.password = this.token;
    // The closed-network git serves the git protocol under /scm/ (the REST API stays at /api/v1).
    return `${u.toString().replace(/\/$/, "")}/scm/${owner}/${repo}.git`;
  }
}
