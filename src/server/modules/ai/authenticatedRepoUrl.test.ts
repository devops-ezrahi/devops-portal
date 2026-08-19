import { describe, expect, it, vi } from "vitest";

async function loadWithGit(git: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("../../config", () => ({
    config: {
      artifactory: { url: "", repo: "", npmRepo: "", token: "" },
      git: { url: "", token: "", username: "", enabled: false, ...git },
      ai: { projects: {}, apiKey: "", model: "anthropic/claude-sonnet-5", baseUrl: "" },
    },
  }));
  return import("./RealAiApi");
}

describe("authenticatedRepoUrl", () => {
  it("leaves the URL alone when GIT_URL/GIT_TOKEN aren't set", async () => {
    const { authenticatedRepoUrl } = await loadWithGit({});
    expect(authenticatedRepoUrl("https://bitbucket.example.com/scm/dem/dp.git")).toBe(
      "https://bitbucket.example.com/scm/dem/dp.git"
    );
  });

  it("puts the token in alone when GIT_USERNAME is unset", async () => {
    const { authenticatedRepoUrl } = await loadWithGit({ token: "pat-123", enabled: true });
    expect(authenticatedRepoUrl("https://bitbucket.example.com/scm/dem/dp.git")).toBe(
      "https://pat-123@bitbucket.example.com/scm/dem/dp.git"
    );
  });

  it("uses username:token when GIT_USERNAME is set", async () => {
    const { authenticatedRepoUrl } = await loadWithGit({ token: "pat-123", username: "svc", enabled: true });
    expect(authenticatedRepoUrl("https://bitbucket.example.com/scm/dem/dp.git")).toBe(
      "https://svc:pat-123@bitbucket.example.com/scm/dem/dp.git"
    );
  });
});
