import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../config", () => ({
  config: { artifactory: { url: "https://art.example.com", repo: "npm-local", npmRepo: "npm-local", token: "t" } },
}));

const { discoverPackages, pool, targetPath } = await import("./npmPackages");

async function writePackage(dir: string, name: string, version: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }));
  await writeFile(join(dir, "index.js"), "module.exports = 1;");
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "npmpkg-test-"));
  await writePackage(join(root, "arg"), "arg", "4.1.5");
  await writePackage(join(root, "@babel", "core"), "@babel/core", "7.24.0");
  // A package with its own nested node_modules.
  await writePackage(join(root, "outer"), "outer", "1.0.0");
  await writePackage(join(root, "outer", "node_modules", "inner"), "inner", "2.0.0");
  // Junk that must be skipped rather than crash the walk.
  await mkdir(join(root, ".bin"), { recursive: true });
  await mkdir(join(root, "broken"), { recursive: true });
  await writeFile(join(root, "broken", "package.json"), "{ not json");
  await mkdir(join(root, "nameless"), { recursive: true });
  await writeFile(join(root, "nameless", "package.json"), JSON.stringify({ description: "no name" }));
});

describe("targetPath", () => {
  it("uses the npm registry layout for an unscoped package", () => {
    expect(targetPath("arg", "4.1.5")).toBe("npm-local/arg/-/arg-4.1.5.tgz");
  });

  it("drops the scope from the filename but keeps it in the path", () => {
    expect(targetPath("@babel/core", "7.24.0")).toBe("npm-local/@babel/core/-/core-7.24.0.tgz");
  });
});

describe("discoverPackages", () => {
  it("finds unscoped, scoped and nested packages", async () => {
    const found = await discoverPackages(root);
    const ids = found.map((p) => `${p.name}@${p.version}`).sort();
    expect(ids).toEqual(["@babel/core@7.24.0", "arg@4.1.5", "inner@2.0.0", "outer@1.0.0"]);
  });

  it("skips directories with unusable manifests and reports why", async () => {
    const skipped: string[] = [];
    await discoverPackages(root, (line) => skipped.push(line));
    expect(skipped.some((s) => s.includes("broken"))).toBe(true);
    expect(skipped.some((s) => s.includes("nameless"))).toBe(true);
  });

  it("returns nothing for a directory with no packages", async () => {
    expect(await discoverPackages(join(root, ".bin"))).toEqual([]);
  });
});

describe("pool", () => {
  it("never exceeds the concurrency limit and runs every item", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];

    await pool(items, 4, async (item) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      done.push(item);
      inFlight--;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(done.sort((a, b) => a - b)).toEqual(items);
  });

  it("handles an empty list without hanging", async () => {
    await expect(pool([], 4, async () => {})).resolves.toBeUndefined();
  });
});
