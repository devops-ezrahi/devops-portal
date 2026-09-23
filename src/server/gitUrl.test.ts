import { describe, expect, it } from "vitest";
import { isSshUrl, normalizeRepoUrl } from "./gitUrl";

describe("normalizeRepoUrl", () => {
  it("rewrites the scp-like form every git host hands out", () => {
    expect(normalizeRepoUrl("git@github.com:devops-ezrahi/universal-chart.git")).toBe(
      "https://github.com/devops-ezrahi/universal-chart.git"
    );
    expect(normalizeRepoUrl("git@bitbucket.example.com:PROJ/values.git")).toBe(
      "https://bitbucket.example.com/scm/PROJ/values.git"
    );
  });

  it("puts Bitbucket Server's /scm/ back, once", () => {
    expect(normalizeRepoUrl("ssh://git@bb.example.com/scm/proj/r.git")).toBe("https://bb.example.com/scm/proj/r.git");
    expect(normalizeRepoUrl("git@gitlab.com:org/r.git")).toBe("https://gitlab.com/org/r.git");
  });

  it("rewrites ssh:// and drops the port", () => {
    // 7999 is Bitbucket Server's SSH port; carrying it onto https would be a
    // URL that certainly fails instead of one that probably works.
    expect(normalizeRepoUrl("ssh://git@bitbucket.example.com:7999/proj/values.git")).toBe(
      "https://bitbucket.example.com/scm/proj/values.git"
    );
    expect(normalizeRepoUrl("ssh://git@github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
  });

  it("leaves an https URL exactly as it is", () => {
    const url = "https://github.com/org/repo.git";
    expect(normalizeRepoUrl(url)).toBe(url);
    expect(isSshUrl(url)).toBe(false);
    expect(normalizeRepoUrl("  https://github.com/org/repo.git  ")).toBe(url);
  });

  it("normalises, it does not sanitise — the guard is still safeRepoUrl's job", () => {
    // A non-network transport is not SSH, so it comes back untouched and is
    // refused downstream.
    expect(normalizeRepoUrl("git://host/r")).toBe("git://host/r");
    expect(normalizeRepoUrl("ftp://host/r")).toBe("ftp://host/r");
    expect(normalizeRepoUrl("")).toBe("");
  });

  it("says when it would rewrite, so the field can explain itself", () => {
    expect(isSshUrl("git@github.com:org/repo.git")).toBe(true);
    expect(isSshUrl("ssh://git@github.com/org/repo.git")).toBe(true);
    expect(isSshUrl("git://host/r")).toBe(false);
  });
});
