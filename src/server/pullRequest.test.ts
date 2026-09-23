import { afterEach, describe, expect, it, vi } from "vitest";
import { bitbucketRepo, canOpenPullRequest, openPullRequest } from "./pullRequest";

describe("bitbucketRepo", () => {
  it("reads project and repo off a /scm/ clone URL, keeping a context path", () => {
    expect(bitbucketRepo("https://bb.example.com/scm/team/tools.git")).toEqual({
      baseUrl: "https://bb.example.com",
      project: "team",
      repo: "tools",
    });
    expect(bitbucketRepo("https://host/bitbucket/scm/~me/repo")?.baseUrl).toBe("https://host/bitbucket");
  });

  it("is null for anything that is not a Bitbucket Server clone URL", () => {
    expect(bitbucketRepo("https://gitlab.example.com/team/tools.git")).toBeNull();
    expect(bitbucketRepo("/tmp/remote.git")).toBeNull();
  });

  it("covers both hosts in canOpenPullRequest", () => {
    expect(canOpenPullRequest("https://github.com/o/r.git")).toBe(true);
    expect(canOpenPullRequest("https://bb/scm/p/r.git")).toBe(true);
    expect(canOpenPullRequest("https://gitlab.com/o/r.git")).toBe(false);
  });
});

describe("openPullRequest on Bitbucket", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates the PR against the REST API beside /scm/", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ links: { self: [{ href: "https://bb/pr/1" }] } })));
    vi.stubGlobal("fetch", fetch);
    const url = await openPullRequest("https://bb/scm/p/r.git", "tok", "portal/x", "main", "T", "B");
    expect(url).toBe("https://bb/pr/1");
    const [called, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(called).toBe("https://bb/rest/api/1.0/projects/p/repos/r/pull-requests");
    expect(JSON.parse(String(init.body)).fromRef.id).toBe("refs/heads/portal/x");
  });

  it("hands back the open PR on a 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("exists", { status: 409 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ values: [{ links: { self: [{ href: "https://bb/pr/7" }] } }] })))
    );
    expect(await openPullRequest("https://bb/scm/p/r.git", "tok", "b", "main", "T", "B")).toBe("https://bb/pr/7");
  });
});
