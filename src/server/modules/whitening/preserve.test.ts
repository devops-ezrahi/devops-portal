import { execFile } from "child_process";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { beforeAll, describe, expect, it } from "vitest";
import { preservedChanges } from "./RealWhiteningApi";

const run = promisify(execFile);

// The pathspec syntax is the part most likely to be wrong, so this exercises the
// real git rather than a stub: build a repo, wipe it the way pushSourceAndOpenPr
// does, and ask which of the staged deletions the patterns cover.
let repoDir: string;

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "preserve-test-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  await mkdir(join(repoDir, ".github/workflows"), { recursive: true });
  await mkdir(join(repoDir, "docs"), { recursive: true });
  await writeFile(join(repoDir, "keep-me.txt"), "keep\n");
  await writeFile(join(repoDir, "gone.txt"), "gone\n");
  await writeFile(join(repoDir, ".github/workflows/ci.yml"), "on: push\n");
  await writeFile(join(repoDir, "docs/notes.md"), "notes\n");
  await writeFile(join(repoDir, "local.env"), "FROM=repo\n");
  await run("git", ["add", "-A"], { cwd: repoDir });
  await run(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
    { cwd: repoDir }
  );

  // The wipe: everything but .git goes, then the pack's tree lands on top.
  for (const entry of ["keep-me.txt", "gone.txt", ".github", "docs", "local.env"]) {
    await rm(join(repoDir, entry), { recursive: true, force: true });
  }
  await writeFile(join(repoDir, "from-pack.txt"), "new\n");
  // The pack ships its own copy of a preserved file — the conflict case.
  await writeFile(join(repoDir, "local.env"), "FROM=pack\n");
  await run("git", ["add", "-A"], { cwd: repoDir });
});

describe("preservedChanges", () => {
  it("matches an exact path and a ** glob, and nothing else", async () => {
    expect(await preservedChanges(repoDir, ["keep-me.txt", ".github/**"], "D")).toEqual([
      ".github/workflows/ci.yml",
      "keep-me.txt",
    ]);
  });

  it("does not let a single * cross a directory boundary", async () => {
    expect(await preservedChanges(repoDir, [".github/*"], "D")).toEqual([]);
  });

  it("returns nothing when no pattern matches a staged deletion", async () => {
    expect(await preservedChanges(repoDir, ["from-pack.txt", "nope/**"], "D")).toEqual([]);
  });

  it("lists a preserved file the pack overwrites, and only that", async () => {
    expect(await preservedChanges(repoDir, ["local.env", "keep-me.txt", ".github/**"], "M")).toEqual(["local.env"]);
  });
});
