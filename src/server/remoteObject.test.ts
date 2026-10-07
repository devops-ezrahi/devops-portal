import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneAt, git, objectAt, remoteObject } from "./git";

/**
 * The builders' "the repository changed since you pulled" check: a pull stores
 * `objectAt` for its file or folder, and `remoteObject` must answer the same id
 * for the same content without a clone — and a different one only when that
 * file or folder changed, not when anything else in the repo did.
 */
let root = "";
let remote = "";
let work = "";

async function commit(path: string, text: string) {
  await mkdir(join(work, path, ".."), { recursive: true });
  await writeFile(join(work, path), text);
  await git(["add", "-A"], work);
  await git(["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-m", `edit ${path}`], work);
  await git(["push", "origin", "main"], work);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "remote-object-test-"));
  remote = join(root, "remote.git");
  work = join(root, "seed");
  await git(["init", "--bare", "--initial-branch=main", remote]);
  await git(["clone", "--", remote, work]);
  await commit("ci/Jenkinsfile", "genStage(title: 'Build')\n");
  await commit("values/base/a.yaml", "replicaCount: 1\n");
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("remoteObject", () => {
  it("names what a pull of the same branch read, for a file and for a folder", async () => {
    const dir = join(root, "clone");
    await cloneAt(remote, "main", dir);
    expect(await remoteObject(remote, "main", "ci/Jenkinsfile")).toBe(await objectAt(dir, "ci/Jenkinsfile"));
    expect(await remoteObject(remote, "main", "values")).toBe(await objectAt(dir, "values"));
    expect(await objectAt(dir, "values")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("moves only when that file or folder changes", async () => {
    const file = await remoteObject(remote, "main", "ci/Jenkinsfile");
    const folder = await remoteObject(remote, "main", "values");

    await commit("README.md", "unrelated\n");
    expect(await remoteObject(remote, "main", "ci/Jenkinsfile")).toBe(file);
    expect(await remoteObject(remote, "main", "values")).toBe(folder);

    await commit("values/prod/values/a.yaml", "replicaCount: 3\n");
    expect(await remoteObject(remote, "main", "values")).not.toBe(folder);
    expect(await remoteObject(remote, "main", "ci/Jenkinsfile")).toBe(file);
  });

  it("answers empty for a branch the remote does not have", async () => {
    expect(await remoteObject(remote, "nope", "ci/Jenkinsfile")).toBe("");
  });
});
