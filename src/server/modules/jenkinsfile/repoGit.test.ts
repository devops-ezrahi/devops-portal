import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { git } from "../../git";
import { pickJenkinsfile, pullJenkinsfile, pushJenkinsfile } from "./repoGit";
import type { JenkinsfilePipeline } from "../../types";

// Not GitHub, so the PR step is skipped and the note explains why — which lets
// the whole clone -> write -> commit -> push chain run for real against a bare
// repo on disk, with no network and nothing stubbed. Same trick as
// `modules/argocd/valuesGit.test.ts`.
vi.mock("../../github", async () => ({
  githubRepo: () => null,
  openPullRequest: async () => "https://github.com/o/r/pull/1",
}));

let root = "";

/** A bare repo seeded with `files`, returned as a clone URL git will take. */
async function remoteWith(name: string, files: Record<string, string>): Promise<string> {
  const remote = join(root, `${name}.git`);
  const work = join(root, `${name}-seed`);
  await git(["init", "--bare", "--initial-branch=main", remote]);
  await git(["clone", "--", remote, work]);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), text, "utf8");
  }
  await git(["add", "-A"], work);
  await git(["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-m", "seed"], work);
  await git(["push", "origin", "main"], work);
  return remote;
}

const pipeline = (repo: JenkinsfilePipeline["repo"]): JenkinsfilePipeline => ({
  id: "JF-0009",
  name: "Test pipeline",
  library: "jenkins-k8s-shared-library",
  envVars: {},
  params: [],
  repo,
  stages: [{ id: "s-1", step: "genStage", args: {}, collapsed: true }],
  createdBy: "alex",
  createdByName: "Alex",
  createdAt: "",
  updatedAt: "",
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "jf-git-test-"));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("pickJenkinsfile", () => {
  it("takes the one at the repo root, whatever else is lying around", () => {
    const pick = pickJenkinsfile(["README.md", "ci/Jenkinsfile.nightly", "Jenkinsfile", "src/app.js"]);
    expect(pick.path).toBe("Jenkinsfile");
  });

  it("takes a single candidate wherever it sits", () => {
    expect(pickJenkinsfile(["README.md", "ci/Jenkinsfile"]).path).toBe("ci/Jenkinsfile");
    expect(pickJenkinsfile(["build/deploy.jenkinsfile"]).path).toBe("build/deploy.jenkinsfile");
  });

  it("asks rather than guessing when there are several", () => {
    // Picking the shallowest would import the wrong pipeline silently and then
    // commit over it — the one failure worth a click to avoid.
    const pick = pickJenkinsfile(["ci/Jenkinsfile", "apps/web/Jenkinsfile"]);
    expect(pick.path).toBe("");
    expect(pick.problem).toMatch(/2 Jenkinsfiles/);
    expect(pick.problem).toContain("apps/web/Jenkinsfile");
    expect(pick.candidates).toEqual(["apps/web/Jenkinsfile", "ci/Jenkinsfile"]);
  });

  it("says so when there is none, and points at the path field", () => {
    const pick = pickJenkinsfile(["README.md", "pom.xml"]);
    expect(pick.path).toBe("");
    expect(pick.problem).toMatch(/No Jenkinsfile/);
  });

  it("does not mistake a file that merely mentions Jenkins", () => {
    expect(pickJenkinsfile(["jenkins.md", "Jenkinsfileold/x.txt", "MyJenkinsfile"]).path).toBe("");
  });
});

describe("pullJenkinsfile", () => {
  it("finds the Jenkinsfile at the root and reads it", async () => {
    const remote = await remoteWith("simple", {
      "Jenkinsfile": "genStage(title: 'Build')\n",
      "README.md": "hi\n",
    });
    const result = await pullJenkinsfile(remote, "main", "");
    expect(result).toMatchObject({ path: "Jenkinsfile" });
    expect("text" in result && result.text).toContain("genStage");
  });

  it("finds one that is not at the root", async () => {
    const remote = await remoteWith("nested", { "ci/pipelines/Jenkinsfile": "semVerStage()\n" });
    const result = await pullJenkinsfile(remote, "main", "");
    expect(result).toMatchObject({ path: "ci/pipelines/Jenkinsfile" });
  });

  it("comes back with a problem, not an exception, when it cannot decide", async () => {
    const remote = await remoteWith("several", {
      "ci/Jenkinsfile": "a()\n",
      "apps/web/Jenkinsfile": "b()\n",
    });
    const result = await pullJenkinsfile(remote, "main", "");
    expect("problem" in result && result.problem).toMatch(/Type the path/);
  });

  it("reads the path it is given instead of searching", async () => {
    const remote = await remoteWith("typed", {
      "ci/Jenkinsfile": "wanted()\n",
      "apps/web/Jenkinsfile": "other()\n",
    });
    const result = await pullJenkinsfile(remote, "main", "ci/Jenkinsfile");
    expect("text" in result && result.text).toContain("wanted()");
  });

  it("says a typed path is not there rather than failing the request", async () => {
    const remote = await remoteWith("missing", { "Jenkinsfile": "x()\n" });
    const result = await pullJenkinsfile(remote, "main", "ci/Jenkinsfile");
    expect("problem" in result && result.problem).toMatch(/no ci\/Jenkinsfile on main/);
  });

  it("refuses to read outside the clone", async () => {
    const remote = await remoteWith("escape", { "Jenkinsfile": "x()\n" });
    await expect(pullJenkinsfile(remote, "main", "../../../etc/passwd")).rejects.toThrow(/Refusing to read/);
  });
});

describe("pushJenkinsfile", () => {
  const branch = "portal/jenkinsfile-jf-0009";
  const push = (remote: string, text: string, path = "Jenkinsfile") =>
    pushJenkinsfile({
      pipeline: pipeline({ repoUrl: remote, revision: "main", path }),
      text,
      branch,
      message: "Update Jenkinsfile",
      authorName: "Alex",
    });

  it("commits the file onto the branch, pushes it, and is a no-op the second time", async () => {
    const remote = await remoteWith("push", { "Jenkinsfile": "old()\n", "README.md": "hi\n" });

    const first = await push(remote, "genStage(title: 'Build')\n");
    expect(first.changed).toBe(true);
    expect(first.branch).toBe(branch);
    expect(await git(["show", `${branch}:Jenkinsfile`], remote)).toContain("genStage");
    // Off GitHub the branch is still pushed; the note is what says the PR is
    // a manual step.
    expect(first.note).toMatch(/open this one by hand/);

    // Pressing Commit twice must update the one branch, not churn it or open a
    // second pull request.
    const again = await push(remote, "genStage(title: 'Build')\n");
    expect(again.changed).toBe(false);
    expect(again.prUrl).toBe("");
  });

  it("writes a Jenkinsfile that is not at the repo root", async () => {
    const remote = await remoteWith("push-nested", { "ci/Jenkinsfile": "old()\n" });
    await push(remote, "new()\n", "ci/Jenkinsfile");
    expect(await git(["show", `${branch}:ci/Jenkinsfile`], remote)).toContain("new()");
    // Only that file: everything else on the branch is the base branch's.
    expect(await git(["show", `${branch}:ci/Jenkinsfile`], remote)).not.toContain("old()");
  });

  it("refuses a path that escapes the clone, before writing anything", async () => {
    const remote = await remoteWith("push-escape", { "Jenkinsfile": "x()\n" });
    await expect(push(remote, "pwned\n", "../../escape")).rejects.toThrow(/Refusing to write/);
    await expect(push(remote, "pwned\n", ".git/hooks/pre-commit")).rejects.toThrow(/Refusing to write/);
  });
});
