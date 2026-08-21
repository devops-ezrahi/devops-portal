import { zipSync } from "fflate";
import { mkdtempSync } from "fs";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import type { PortalUser } from "../../types";

vi.mock("../../config", () => ({
  config: {
    // Fresh per run: the job store persists, so a shared dir would carry ids
    // and history over from the last `npm test`.
    dataDir: mkdtempSync(join(tmpdir(), "artifactory-test-")),
    // A realistic token, not "t" — redactSecrets would blank every letter t in the log.
    artifactory: {
      url: "https://art.example.com",
      repo: "npm-local",
      npmRepo: "npm-local",
      token: "AKCp8-fake-token",
      mavenRepo: "maven-local",
      rpmRepo: "rpm-local",
    },
    git: { token: "" }, // redactSecrets reads all three
    ai: { apiKey: "" },
  },
}));

// Real tar still runs; only the network is faked. `arg` is already in the repo,
// `@babel/core` is rejected by Artifactory — one job showing all three outcomes.
vi.mock("./artifactoryRest", () => ({
  exists: async (path: string) => path.includes("/arg/"),
  // null forces the per-item HEAD fallback these tests exercise, rather than
  // the bulk-listing fast path added for repeat node_modules uploads.
  listExisting: async () => null,
  upload: async (path: string) => {
    if (path.includes("@babel")) {
      throw new Error("Artifactory responded 403 Forbidden: deploy denied for path");
    }
  },
  webUrl: (path: string) => `https://art.example.com/ui/repos/tree/General/${path}`,
  nativeUrl: (path: string) => `https://art.example.com/ui/native/${path}`,
}));

const { RealArtifactoryApi } = await import("./RealArtifactoryApi");

/** One tree entry: relative path -> contents, the shape a dropped folder has. */
type Entry = [path: string, contents: Buffer];

function pkg(dir: string, name: string, version: string): Entry[] {
  return [
    [`${dir}/package.json`, Buffer.from(JSON.stringify({ name, version, main: "index.js" }))],
    [`${dir}/index.js`, Buffer.from("module.exports = 1;\n")],
  ];
}

function file(path: string, contents = Buffer.from(path)): Entry {
  return [path, contents];
}

const user: PortalUser = {
  id: "dana",
  displayName: "Dana Levi",
  email: "dana@example.com",
  groups: [],
};

/**
 * Submit a folder upload and wait for the job to settle. The tree is zipped to a
 * temp file first, because that is exactly what the router hands the job: multer
 * streams the client's archive to disk and passes down its path.
 */
async function run(entries: Entry[], folderName: string) {
  const inputs: Record<string, Uint8Array> = {};
  for (const [path, contents] of entries) inputs[path] = new Uint8Array(contents);
  const dir = await mkdtemp(join(tmpdir(), "art-"));
  const archivePath = join(dir, "upload.zip");
  await writeFile(archivePath, zipSync(inputs));

  const api = new RealArtifactoryApi();
  const { id } = await api.submitFolderUpload(
    {
      folderName,
      fileCount: entries.length,
      totalBytes: entries.reduce((n, [, contents]) => n + contents.length, 0),
      archivePath,
    },
    user
  );

  let job = await api.getJob(id);
  while (job && (job.status === "pending" || job.status === "in-progress")) {
    await new Promise((r) => setTimeout(r, 20));
    job = await api.getJob(id);
  }

  console.log(`\n--- ${id} (${job!.status}) ---\n${job!.log.join("\n")}\n`);
  return job!;
}

describe("folder upload log", () => {
  it("reports skipped, uploaded and failed packages", async () => {
    const job = await run(
      [
        ...pkg("node_modules/arg", "arg", "4.1.5"),
        ...pkg("node_modules/left-pad", "left-pad", "1.3.0"),
        ...pkg("node_modules/@babel/core", "@babel/core", "7.24.0"),
      ],
      "node_modules"
    );

    expect(job.status).toBe("failed");
    expect(job.log).toContain("Uploaded left-pad@1.3.0");
    expect(job.log.some((l) => l.includes("1 package(s) already in the repo"))).toBe(true);
    expect(job.log.some((l) => l.startsWith("Failed @babel/core@7.24.0:"))).toBe(true);
    expect(job.log.at(-1)).toBe("Done. 1 uploaded, 1 already present, 1 failed.");
  });

  it("routes each type to its own repo and leaves node_modules contents alone", async () => {
    const files: Entry[] = [
      ...pkg("node_modules/left-pad", "left-pad", "1.3.0"),
      // A jar inside an npm package ships in that package's tarball — it must not
      // be picked up as a Maven dependency of its own.
      file("node_modules/left-pad/vendor/embedded-1.0.jar"),
      file("org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar"),
      file("rpms/nginx-1.24.0-1.el9.x86_64.rpm"),
      file("notes.txt"),
    ];

    const job = await run(files, "mixed");

    expect(job.status).toBe("completed");
    const paths = job.packages!.map((p) => p.path).sort();
    expect(paths).toEqual([
      "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
      "npm-local/left-pad/-/left-pad-1.3.0.tgz",
      "rpm-local/nginx-1.24.0-1.el9.x86_64.rpm",
    ]);
    expect(job.log).toContain("1 unrecognised file(s) skipped.");
  });

  // This used to fall back to uploading the tree verbatim under the folder's
  // own name, which quietly published junk into the npm repo.
  it("fails the job when nothing in the folder is a package", async () => {
    const job = await run([file("notes.txt"), file("photo.png"), file("data.csv")], "junk");

    expect(job.status).toBe("failed");
    expect(job.errorMessage).toContain("No recognised packages in junk");
    expect(job.packages ?? []).toEqual([]);
  });

  // classify() ignores .tgz on purpose — the filename can't give the scope —
  // so a folder of loose tarballs is only recognised by reading each manifest.
  it("recognises loose .tgz tarballs by their manifest, scope included", async () => {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const { mkdtemp, mkdir, writeFile, readFile } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const execFileAsync = promisify(execFile);

    // A real npm-shaped tarball: tar reads package/package.json out of it.
    const dir = await mkdtemp(join(tmpdir(), "tgz-"));
    await mkdir(join(dir, "package"), { recursive: true });
    await writeFile(
      join(dir, "package", "package.json"),
      JSON.stringify({ name: "@acme/parser", version: "7.24.0" })
    );
    await execFileAsync("tar", ["-czf", "parser-7.24.0.tgz", "package"], { cwd: dir });
    const tarball = await readFile(join(dir, "parser-7.24.0.tgz"));

    const job = await run([file("tarballs/parser-7.24.0.tgz", tarball)], "tarballs");

    expect(job.status).toBe("completed");
    expect(job.packages!.map((p) => p.path)).toEqual([
      "npm-local/@acme/parser/-/parser-7.24.0.tgz"
    ]);
  });
});

// A URL copy used to run its own bespoke exists/upload tail and set only `log`
// and `resultUrl`. JobDetail renders the progress bar off `progress` and the
// package table (with its direct link) off `packages`, so neither appeared for
// a URL copy — the reason its output looked nothing like a folder upload's.
describe("url copy", () => {
  it("reports packages and progress like a folder upload does", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.from("not really a tarball"), { status: 200 }))
    );

    const api = new RealArtifactoryApi();
    const { id } = await api.submitUrlCopy(
      { sourceUrl: "https://repo1.maven.org/maven2/org/foo/bar/1.0.0/bar-1.0.0.jar" },
      user
    );

    let job = await api.getJob(id);
    while (job && (job.status === "pending" || job.status === "in-progress")) {
      await new Promise((r) => setTimeout(r, 20));
      job = await api.getJob(id);
    }

    expect(job!.status).toBe("completed");
    expect(job!.packages).toHaveLength(1);
    expect(job!.packages![0].path).toBe("maven-local/org/foo/bar/1.0.0/bar-1.0.0.jar");
    expect(job!.packages![0].nativeUrl).toBeTruthy();
    expect(job!.progress).toEqual({ done: 1, total: 1 });

    vi.unstubAllGlobals();
  });
});
