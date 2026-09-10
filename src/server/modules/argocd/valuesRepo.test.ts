import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { safeDirPath, safeRef, safeRepoUrl, safeTreePath } from "./valuesRepo";
import { withCredentials } from "../../git";
import { config } from "../../config";

describe("safeTreePath", () => {
  it("accepts the paths buildTree actually writes", () => {
    for (const path of [
      "base/api-gateway.yaml",
      "shop-web/defaults.yaml",
      "shop-web/values/storefront.yaml",
      "root-applicationSet.yaml",
      "root-application.yaml",
    ])
      expect(safeTreePath(path), path).toBe(true);
  });

  it("refuses anything that escapes the tree or reaches the repository's own machinery", () => {
    for (const path of [
      "../outside.yaml",
      "a/../../outside.yaml",
      "/etc/passwd.yaml",
      // The sharp one: git executes this on the very next command in the request.
      ".git/hooks/pre-commit.yaml",
      "base/.git/config.yaml",
      "base/.GIT/config.yaml",
      "a\\b.yaml", // a separator on the dev box this is written on
      "-rf.yaml",
      "a//b.yaml",
      "./x.yaml",
      "x.txt",
      "x.yaml.sh",
      `${"a/".repeat(120)}x.yaml`,
    ])
      expect(safeTreePath(path), path).toBe(false);
  });
});

describe("safeRepoUrl / safeRef / safeDirPath", () => {
  it("clones only over http(s)", () => {
    expect(safeRepoUrl("https://github.com/o/r.git")).toBe(true);
    expect(safeRepoUrl("http://git.internal/o/r.git")).toBe(true);
    // `ext::` is git's shell transport — its "URL" is a command git runs.
    expect(safeRepoUrl("ext::sh -c 'curl evil'")).toBe(false);
    expect(safeRepoUrl("file:///etc")).toBe(false);
    expect(safeRepoUrl("ssh://git@host/o/r.git")).toBe(false);
    expect(safeRepoUrl("--upload-pack=touch pwned")).toBe(false);
    expect(safeRepoUrl("")).toBe(false);
  });

  it("takes a branch name, not an option", () => {
    expect(safeRef("main")).toBe(true);
    expect(safeRef("release/1.2.x")).toBe(true);
    expect(safeRef("--upload-pack=x")).toBe(false);
    expect(safeRef("a..b")).toBe(false);
    expect(safeRef("")).toBe(false);
  });

  it("takes a subdirectory, and the repo root", () => {
    expect(safeDirPath("")).toBe(true);
    expect(safeDirPath("apps")).toBe(true);
    expect(safeDirPath("apps/team-a")).toBe(true);
    expect(safeDirPath("../etc")).toBe(false);
    expect(safeDirPath("apps/.git")).toBe(false);
  });
});

describe("valuesTokenFor", () => {
  // config is frozen at import, so each case re-imports the module with its own env.
  const env = { ...process.env };
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    process.env = { ...env };
    vi.resetModules();
  });

  async function tokenFor(vars: Record<string, string>, repoUrl: string) {
    process.env = { ...env, ...vars };
    const { valuesTokenFor } = await import("./valuesRepo");
    return valuesTokenFor(repoUrl);
  }

  it("never sends the Bitbucket token to another host", async () => {
    // The whole point of the host match: `values.repoUrl` is a field the user
    // can edit, so pointing it anywhere must not hand that host GIT_TOKEN.
    const result = await tokenFor(
      { GIT_URL: "https://bitbucket.corp", GIT_TOKEN: "bitbucket-secret", ARGOCD_VALUES_TOKEN: "" },
      "https://github.com/devops-ezrahi/values.git"
    );
    expect(result.token).toBe("");
  });

  it("reuses GIT_TOKEN when the values repo is on the same host", async () => {
    const result = await tokenFor(
      { GIT_URL: "https://bitbucket.corp/scm", GIT_TOKEN: "bitbucket-secret" },
      "https://bitbucket.corp/scm/gitops/values.git"
    );
    expect(result.token).toBe("bitbucket-secret");
  });

  it("falls back to ARGOCD_VALUES_TOKEN for any other host", async () => {
    const result = await tokenFor(
      { GIT_URL: "https://bitbucket.corp", GIT_TOKEN: "bitbucket-secret", ARGOCD_VALUES_TOKEN: "gh-secret" },
      "https://github.com/devops-ezrahi/values.git"
    );
    expect(result).toEqual({ token: "gh-secret", username: "" });
  });
});

describe("withCredentials", () => {
  it("puts the token in on its own, or as user:pass when a username is set", () => {
    expect(withCredentials("https://github.com/o/r.git", "tok")).toBe("https://tok@github.com/o/r.git");
    expect(withCredentials("https://github.com/o/r.git", "tok", "alex")).toBe("https://alex:tok@github.com/o/r.git");
  });

  it("leaves alone what it cannot rewrite — an SSH form still clones via the machine's key", () => {
    expect(withCredentials("git@github.com:o/r.git", "tok")).toBe("git@github.com:o/r.git");
    expect(withCredentials("https://github.com/o/r.git", "")).toBe("https://github.com/o/r.git");
  });

  it("is what config.argocd.valuesToken feeds", () => {
    // Guards the config wiring itself: a renamed key would leave the field
    // undefined and every push anonymous, with no other test noticing.
    expect(config.argocd).toHaveProperty("valuesToken");
  });
});
