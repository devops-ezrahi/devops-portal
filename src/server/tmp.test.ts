import { mkdir, stat, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { createTmpDir, removeTmpDir, sweepOldTmpDirs } from "./tmp";

const DAY_MS = 24 * 60 * 60 * 1000;

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("createTmpDir / removeTmpDir", () => {
  it("creates a unique dir under the OS temp dir and removes it with its contents", async () => {
    const a = await createTmpDir("art-");
    const b = await createTmpDir("art-");
    expect(a).not.toBe(b);

    await mkdir(join(a, "nested"), { recursive: true });
    await writeFile(join(a, "nested", "file.txt"), "x");

    await removeTmpDir(a);
    await removeTmpDir(b);
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(false);
  });

  it("never throws on a dir that is already gone", async () => {
    const warnings: string[] = [];
    await removeTmpDir(join(tmpdir(), "art-does-not-exist"), (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});

describe("sweepOldTmpDirs", () => {
  it("deletes stale job dirs but leaves fresh ones and anything it does not own", async () => {
    const stale = await createTmpDir("wht-");
    const fresh = await createTmpDir("art-");
    const foreign = await createTmpDir("notours-");

    const old = new Date(Date.now() - 2 * DAY_MS);
    await utimes(stale, old, old);
    await utimes(foreign, old, old);

    await sweepOldTmpDirs();

    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(foreign)).toBe(true);

    await removeTmpDir(fresh);
    await removeTmpDir(foreign);
  });

  it("leaves a job dir alone until it crosses the age cutoff", async () => {
    const dir = await createTmpDir("art-");
    await writeFile(join(dir, "work.txt"), "x");

    await sweepOldTmpDirs();
    expect(await exists(dir)).toBe(true);

    // Same dir, one minute past the cutoff.
    const old = new Date(Date.now() - DAY_MS - 60_000);
    await utimes(dir, old, old);
    await sweepOldTmpDirs();
    expect(await exists(dir)).toBe(false);
  });
});
