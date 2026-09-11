import { afterEach, describe, expect, it, vi } from "vitest";
import { githubRepo, openPullRequest } from "./github";

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("githubRepo", () => {
  it("reads owner and repo off a GitHub URL, with or without .git", () => {
    expect(githubRepo("https://github.com/devops-ezrahi/values.git")).toEqual({
      apiBase: "https://api.github.com",
      owner: "devops-ezrahi",
      repo: "values",
    });
    expect(githubRepo("https://www.github.com/o/r")?.owner).toBe("o");
  });

  it("is null for anything else — which is what makes the push say 'open it by hand'", () => {
    expect(githubRepo("https://bitbucket.corp/scm/gitops/values.git")).toBeNull();
    expect(githubRepo("https://github.com/o/r/tree/main")).toBeNull();
    expect(githubRepo("https://github.com/o")).toBeNull();
    expect(githubRepo("not a url")).toBeNull();
  });
});

describe("openPullRequest", () => {
  it("POSTs the pull request and returns its web URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(201, { html_url: "https://github.com/o/r/pull/7" }));
    vi.stubGlobal("fetch", fetchMock);

    const url = await openPullRequest("https://github.com/o/r.git", "tok", "portal/x", "main", "Title", "Body");

    expect(url).toBe("https://github.com/o/r/pull/7");
    const [called, init] = fetchMock.mock.calls[0];
    expect(called).toBe("https://api.github.com/repos/o/r/pulls");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ title: "Title", head: "portal/x", base: "main", body: "Body" });
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("reuses the open pull request when the branch already has one", async () => {
    // The branch is per tree and force-pushed, so a second press is normal —
    // GitHub answers that create with a 422, exactly as Bitbucket answers 409.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(422, { message: "Validation Failed", errors: [{ message: "A pull request already exists" }] }))
      .mockResolvedValueOnce(json(200, [{ html_url: "https://github.com/o/r/pull/3" }]));
    vi.stubGlobal("fetch", fetchMock);

    const url = await openPullRequest("https://github.com/o/r.git", "tok", "portal/x", "main", "T", "B");

    expect(url).toBe("https://github.com/o/r/pull/3");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.github.com/repos/o/r/pulls?state=open&head=o%3Aportal%2Fx");
  });

  it("reports what GitHub said when it refuses and there is no open PR", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(422, { message: "Validation Failed", errors: [{ message: "base is invalid" }] }))
        .mockResolvedValueOnce(json(200, []))
    );
    await expect(openPullRequest("https://github.com/o/r.git", "tok", "b", "nope", "T", "B")).rejects.toThrow(
      /base is invalid/
    );
  });
});
