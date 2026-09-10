import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { git } from "../../git";
import { pullValuesTree, pushValuesTree } from "./valuesGit";
import type { ArgocdTree } from "../../types";

// Not GitHub, so the PR step is skipped and the note explains why — which lets
// the whole clone -> write -> commit -> push chain run for real against a bare
// repo on disk, with no network and nothing stubbed.
vi.mock("./github", async () => ({
  githubRepo: () => null,
  openPullRequest: async () => "https://github.com/o/r/pull/1",
}));

let remote = "";
let work = "";

const tree = (over: Partial<ArgocdTree> = {}): ArgocdTree => ({
  id: "AG-0009",
  name: "Test tree",
  chart: { repoUrl: "https://github.com/devops-ezrahi/universal-chart.git", path: ".", appsetPath: "ms-applicationSet", revision: "main" },
  values: { repoUrl: remote, revision: "main", path: "" },
  rootAppName: "platform-root",
  releases: [{ id: "r1", name: "api", features: {} }],
  namespaces: [],
  createdBy: "alex",
  createdByName: "Alex",
  createdAt: "",
  updatedAt: "",
  ...over,
});

const push = (files: { path: string; text: string }[], over: Partial<ArgocdTree> = {}) =>
  pushValuesTree({ tree: tree(over), files, branch: "portal/argocd-ag-0009", message: "Update tree", authorName: "Alex" });

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "ag-test-"));
  remote = join(root, "remote.git");
  work = join(root, "seed");
  await git(["init", "--bare", "--initial-branch=main", remote]);
  await git(["clone", "--", remote, work]);
  await git(["-c", "user.email=t@t", "-c", "user.name=T", "commit", "--allow-empty", "-m", "root"], work);
  await git(["push", "origin", "main"], work);
});

afterAll(async () => {
  if (remote) await rm(join(remote, ".."), { recursive: true, force: true });
});

/** What the pushed branch actually holds, read back out of the bare repo. */
const show = (path: string) => git(["show", `portal/argocd-ag-0009:${path}`], remote);

describe("pushValuesTree", () => {
  it("commits the files onto the branch and pushes them", async () => {
    const result = await push([
      { path: "base/api.yaml", text: "image:\n  tag: 1.0.0\n" },
      { path: "prod/values/api.yaml", text: "image:\n  tag: 1.4.2\n" },
    ]);

    expect(result.changed).toBe(true);
    expect(result.branch).toBe("portal/argocd-ag-0009");
    expect(await show("base/api.yaml")).toContain("tag: 1.0.0");
    expect(await show("prod/values/api.yaml")).toContain("tag: 1.4.2");
  });

  it("says so and opens nothing when the push would change nothing", async () => {
    // The same files again. Pressing the button twice must not open a second
    // pull request, or churn the branch.
    const result = await push([
      { path: "base/api.yaml", text: "image:\n  tag: 1.0.0\n" },
      { path: "prod/values/api.yaml", text: "image:\n  tag: 1.4.2\n" },
    ]);
    expect(result.changed).toBe(false);
    expect(result.prUrl).toBe("");
  });

  it("says the branch was pushed but the PR must be opened by hand off GitHub", async () => {
    const result = await push([{ path: "base/api.yaml", text: "image:\n  tag: 2.0.0\n" }]);
    expect(result.changed).toBe(true);
    expect(result.note).toMatch(/open this one by hand/);
  });

  it("refuses a path that escapes the tree, before writing anything", async () => {
    await expect(push([{ path: "../../escape.yaml", text: "x: 1\n" }])).rejects.toThrow(/Refusing to write/);
    await expect(push([{ path: ".git/hooks/pre-commit.yaml", text: "x: 1\n" }])).rejects.toThrow(/Refusing to write/);
  });

  it("removes what the tree no longer has, but only under a values subdirectory", async () => {
    const under = { values: { repoUrl: remote, revision: "main", path: "apps" } };
    await push([{ path: "base/api.yaml", text: "a: 1\n" }, { path: "base/gone.yaml", text: "b: 2\n" }], under);
    expect(await show("apps/base/gone.yaml")).toContain("b: 2");

    await push([{ path: "base/api.yaml", text: "a: 1\n" }], under);
    // The subdirectory belongs to this tree outright, so a dropped release
    // really disappears. At the repo root it would still be there.
    await expect(show("apps/base/gone.yaml")).rejects.toThrow();
  });
});

describe("pullValuesTree", () => {
  it("reads the tree back out of the repo it was pushed to", async () => {
    const files = await pullValuesTree(remote, "portal/argocd-ag-0009", "");
    const paths = files.map((f) => f.path);
    expect(paths).toContain("base/api.yaml");
    expect(files.find((f) => f.path === "base/api.yaml")!.text).toContain("tag: 2.0.0");
  });

  it("reads only the subdirectory it is pointed at", async () => {
    const files = await pullValuesTree(remote, "portal/argocd-ag-0009", "apps");
    expect(files.map((f) => f.path)).toEqual(["base/api.yaml"]);
  });
});
