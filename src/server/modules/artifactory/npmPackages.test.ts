import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config", () => ({
  config: {
    artifactory: { url: "https://art.example.com", repo: "npm-local", npmRepo: "npm-local", token: "t" },
    // redactSecrets, reached via the REST layer's log lines, reads all three.
    git: { token: "" },
    ai: { apiKey: "" },
  },
}));

const listExistingMock = vi.fn();
const existsMock = vi.fn();
const uploadMock = vi.fn(async (_path: string, _localFile: string) => {});

vi.mock("./artifactoryRest", () => ({
  listExisting: (repoPath: string) => listExistingMock(repoPath),
  exists: (path: string) => existsMock(path),
  upload: (path: string, localFile: string) => uploadMock(path, localFile),
  webUrl: (path: string) => path,
  nativeUrl: (path: string) => path,
  // Every URL copy asks this first; null is "the URL names a file", which is
  // what every case here is.
  listSourceFolder: async () => null,
  sourceHeaders: () => ({}),
}));

const { discoverPackages, pool, targetPath, uniquePackages, uploadFiles } = await import("./npmPackages");
type UploadItem = Parameters<typeof uploadFiles>[0][number];

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
  // A package.json buried in the package's own subtree (an example app), not
  // inside node_modules — must not be discovered as if it were a dependency.
  await writePackage(join(root, "outer", "examples", "demo"), "demo-app", "0.0.1");
  // npm nests a second copy of the same version whenever hoisting cannot reach
  // a dependent. It packs to the same tarball at the same path as the copy
  // already found.
  await writePackage(join(root, "outer", "node_modules", "arg"), "arg", "4.1.5");
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
    // `arg` twice: the top-level copy and the nested one, which is what npm
    // leaves behind and what `uniquePackages` (not this) folds together.
    expect(ids).toEqual([
      "@babel/core@7.24.0",
      "arg@4.1.5",
      "arg@4.1.5",
      "inner@2.0.0",
      "outer@1.0.0",
    ]);
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

  // Every copy is returned: the caller uses the directory list to tell which
  // files on disk belong to a package, and dropping one here reports every file
  // inside it as an unrelated loose file instead.
  it("returns every copy of a package, duplicates included", async () => {
    const found = await discoverPackages(root);
    expect(found.filter((p) => p.name === "arg")).toHaveLength(2);
  });

  it("does not descend into a package's own non-node_modules subdirectories", async () => {
    const found = await discoverPackages(root);
    expect(found.some((p) => p.name === "demo-app")).toBe(false);
  });
});

describe("uniquePackages", () => {
  it("keeps one package per name@version and says how many it dropped", async () => {
    const skipped: string[] = [];
    const unique = uniquePackages(await discoverPackages(root), (line) => skipped.push(line));

    expect(unique.filter((p) => p.name === "arg")).toHaveLength(1);
    expect(skipped.some((s) => s.includes("1 duplicate"))).toBe(true);
  });

  it("keeps a nested copy of a different version", () => {
    const packages = [
      { dir: "/a", name: "arg", version: "4.1.5" },
      { dir: "/b/node_modules/arg", name: "arg", version: "5.0.0" },
    ];
    expect(uniquePackages(packages)).toHaveLength(2);
  });
});

describe("uploadFiles bulk existence check", () => {
  function npmItem(name: string, version: string): UploadItem {
    return { path: targetPath(name, version), name, version, type: "npm", resolve: async () => "/dev/null" };
  }

  beforeEach(() => {
    listExistingMock.mockReset();
    existsMock.mockReset();
    uploadMock.mockReset().mockResolvedValue(undefined);
  });

  /** Enough npm items to be worth one repo listing (BULK_LIST_THRESHOLD). */
  function manyNpmItems(): UploadItem[] {
    return [
      npmItem("arg", "4.1.5"),
      ...Array.from({ length: 24 }, (_, i) => npmItem(`pkg-${i}`, "1.0.0")),
    ];
  }

  it("skips per-item HEAD entirely when the bulk listing succeeds", async () => {
    listExistingMock.mockResolvedValue(new Set([targetPath("arg", "4.1.5")]));

    const results = await uploadFiles(manyNpmItems(), () => {}, () => {});

    expect(listExistingMock.mock.calls[0][0]).toBe("npm-local");
    expect(existsMock).not.toHaveBeenCalled();
    expect(results.find((r) => r.name === "arg")!.status).toBe("exists");
    expect(results.find((r) => r.name === "pkg-0")!.status).toBe("uploaded");
    expect(uploadMock).toHaveBeenCalledTimes(24);
  });

  it("falls back to per-item HEAD when the bulk listing is not usable", async () => {
    listExistingMock.mockResolvedValue(null);
    existsMock.mockImplementation(async (path: string) => path.includes("/arg/"));

    const results = await uploadFiles(manyNpmItems(), () => {}, () => {});

    expect(existsMock).toHaveBeenCalledTimes(25);
    expect(results.find((r) => r.name === "arg")!.status).toBe("exists");
    expect(results.find((r) => r.name === "pkg-0")!.status).toBe("uploaded");
  });

  // `?list&deep=1` makes Artifactory walk the whole npm repo. That pays for a
  // node_modules-sized drop and is pure overhead for a couple of tarballs.
  it("does not list the repo for a handful of packages", async () => {
    existsMock.mockResolvedValue(false);

    await uploadFiles([npmItem("arg", "4.1.5"), npmItem("left-pad", "1.3.0")], () => {}, () => {});

    expect(listExistingMock).not.toHaveBeenCalled();
    expect(existsMock).toHaveBeenCalledTimes(2);
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
