import { afterEach, describe, expect, it, vi } from "vitest";
import { BitbucketApi, BitbucketError } from "./BitbucketApi";

const api = new BitbucketApi({ url: "https://bitbucket.example.com/", token: "pat-123", username: "" });

function stubFetch(...responses: { status: number; body?: unknown }[]) {
  const fn = vi.fn(async (_url: string, _options?: RequestInit) => {
    const next = responses.shift() ?? { status: 200, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: String(next.status),
      text: async () => (next.body === undefined ? "" : JSON.stringify(next.body)),
    } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("BitbucketApi request shape", () => {
  it("targets /rest/api/1.0 with a Bearer token", async () => {
    const fetchMock = stubFetch({ status: 200, body: { slug: "devops-portal" } });
    await api.repoExists("dem", "devops-portal");

    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://bitbucket.example.com/rest/api/1.0/projects/dem/repos/devops-portal");
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer pat-123");
  });

  it("reports a missing repo instead of throwing", async () => {
    stubFetch({ status: 404, body: { errors: [] } });
    expect(await api.repoExists("dem", "nope")).toBe(false);
  });

  it("surfaces the status on other failures", async () => {
    stubFetch({ status: 401, body: {} });
    await expect(api.repoExists("dem", "devops-portal")).rejects.toMatchObject({ status: 401 });
  });
});

describe("getDefaultBranch", () => {
  it("reads displayId from the branches/default endpoint", async () => {
    const fetchMock = stubFetch({ status: 200, body: { id: "refs/heads/main", displayId: "main" } });
    expect(await api.getDefaultBranch("dem", "devops-portal")).toBe("main");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://bitbucket.example.com/rest/api/1.0/projects/dem/repos/devops-portal/branches/default"
    );
  });
});

describe("createPullRequest", () => {
  it("posts fromRef/toRef and returns links.self[0].href", async () => {
    const fetchMock = stubFetch({
      status: 201,
      body: { links: { self: [{ href: "https://bitbucket.example.com/projects/DEM/repos/dp/pull-requests/7" }] } },
    });

    const url = await api.createPullRequest("dem", "dp", "whitening/x-1.0.0", "main", "Title", "Body");

    const [requestUrl, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe("https://bitbucket.example.com/rest/api/1.0/projects/dem/repos/dp/pull-requests");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({
      title: "Title",
      description: "Body",
      fromRef: { id: "refs/heads/whitening/x-1.0.0" },
      toRef: { id: "refs/heads/main" },
    });
    expect(url).toBe("https://bitbucket.example.com/projects/DEM/repos/dp/pull-requests/7");
  });

  it("raises a 409 the caller can catch to reuse an open PR", async () => {
    stubFetch({ status: 409, body: { errors: [{ message: "duplicate" }] } });
    await expect(api.createPullRequest("dem", "dp", "b", "main", "t", "d")).rejects.toBeInstanceOf(BitbucketError);
  });
});

describe("findOpenPullRequest", () => {
  it("queries by source ref and returns the first match", async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: { values: [{ links: { self: [{ href: "https://bitbucket.example.com/pr/7" }] } }] },
    });

    expect(await api.findOpenPullRequest("dem", "dp", "whitening/x-1.0.0")).toBe(
      "https://bitbucket.example.com/pr/7"
    );
    expect(fetchMock.mock.calls[0][0]).toContain("at=refs%2Fheads%2Fwhitening%2Fx-1.0.0");
  });

  it("returns null when nothing is open", async () => {
    stubFetch({ status: 200, body: { values: [] } });
    expect(await api.findOpenPullRequest("dem", "dp", "b")).toBeNull();
  });
});

describe("authenticatedCloneUrl", () => {
  it("puts the token in alone when GIT_USERNAME is unset", () => {
    expect(api.authenticatedCloneUrl("dem", "devops-portal")).toBe(
      "https://pat-123@bitbucket.example.com/scm/dem/devops-portal.git"
    );
  });

  it("uses username:token when GIT_USERNAME is set", () => {
    const withUser = new BitbucketApi({ url: "https://bitbucket.example.com", token: "pat-123", username: "svc" });
    expect(withUser.authenticatedCloneUrl("dem", "dp")).toBe(
      "https://svc:pat-123@bitbucket.example.com/scm/dem/dp.git"
    );
  });
});
