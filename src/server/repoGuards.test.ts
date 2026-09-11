import { describe, expect, it } from "vitest";
import { safeDirPath, safeFilePath, safeRef, safeRepoUrl } from "./repoGuards";

/**
 * `safeRepoUrl`, `safeRef` and `safeDirPath` are covered from the ArgoCD side
 * too (`modules/argocd/valuesRepo.test.ts`, through the re-export) — the cases
 * here are the ones that matter now that a second module points git at a URL a
 * user typed, plus `safeFilePath`, which is new.
 */

describe("safeRepoUrl", () => {
  it("clones only over http(s)", () => {
    expect(safeRepoUrl("https://github.com/o/checkout-service.git")).toBe(true);
    expect(safeRepoUrl("http://bitbucket.internal/scm/proj/repo.git")).toBe(true);
    // `ext::` is git's shell transport — its "URL" is a command git runs.
    expect(safeRepoUrl("ext::sh -c 'curl evil'")).toBe(false);
    expect(safeRepoUrl("file:///etc")).toBe(false);
    expect(safeRepoUrl("ssh://git@host/o/r.git")).toBe(false);
    expect(safeRepoUrl("--upload-pack=touch pwned")).toBe(false);
    expect(safeRepoUrl("")).toBe(false);
  });
});

describe("safeRef", () => {
  it("takes a branch name, not an option", () => {
    expect(safeRef("main")).toBe(true);
    expect(safeRef("release/1.2.x")).toBe(true);
    expect(safeRef("--upload-pack=x")).toBe(false);
    expect(safeRef("a..b")).toBe(false);
    expect(safeRef("")).toBe(false);
  });
});

describe("safeDirPath", () => {
  it("takes a subdirectory, and the repo root", () => {
    expect(safeDirPath("")).toBe(true);
    expect(safeDirPath("apps/team-a")).toBe(true);
    expect(safeDirPath("../up")).toBe(false);
    expect(safeDirPath(".git")).toBe(false);
  });
});

describe("safeFilePath", () => {
  it("takes the paths a Jenkinsfile actually lives at, extension or not", () => {
    for (const path of ["Jenkinsfile", "ci/Jenkinsfile", "Jenkinsfile.release", "build/deploy.jenkinsfile"])
      expect(safeFilePath(path), path).toBe(true);
  });

  it("refuses anything that escapes the clone or reaches git's own machinery", () => {
    for (const path of [
      "",
      "../outside",
      "a/../../outside",
      "/etc/passwd",
      // The sharp one: git executes this on the very next command in the request.
      ".git/hooks/pre-commit",
      "ci/.git/config",
      "ci/.GIT/config",
      "a\\b", // a separator on the dev box this is written on
      "-rf",
      "a//b",
      "./x",
      `${"a/".repeat(120)}Jenkinsfile`,
    ])
      expect(safeFilePath(path), path).toBe(false);
  });
});
