import { zipSync } from "fflate";
import { execFile } from "child_process";
import { mkdtempSync } from "fs";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalUser } from "../../types";

const execFileAsync = promisify(execFile);

vi.mock("../../config", () => ({
  config: {
    dataDir: mkdtempSync(join(tmpdir(), "artifactory-unpack-")),
    artifactory: {
      url: "https://art.example.com",
      repo: "generic-local",
      npmRepo: "npm-local",
      token: "AKCp8-fake-token",
      mavenRepo: "maven-local",
      rpmRepo: "rpm-local",
      pypiRepo: "pypi-local",
      condaRepo: "conda-local",
      helmRepo: "helm-local",
      npmSourceToken: "",
    },
    git: { token: "" },
    ai: { apiKey: "" },
  },
}));

const uploaded = new Map<string, Buffer>();

vi.mock("./artifactoryRest", () => ({
  exists: async () => false,
  listExisting: async () => null,
  upload: async (path: string, localFile: string) => {
    uploaded.set(path, await readFile(localFile));
  },
  webUrl: (path: string) => `https://art.example.com/ui/repos/tree/General/${path}`,
  nativeUrl: (path: string) => `https://art.example.com/ui/native/${path}`,
  listSourceFolder: async () => null,
  sourceHeaders: () => ({}),
}));

const { RealArtifactoryApi } = await import("./RealArtifactoryApi");

const user: PortalUser = { id: "dana", displayName: "Dana Levi", email: "d@x.io", groups: [] };

async function settled(api: InstanceType<typeof RealArtifactoryApi>, id: string) {
  let job = await api.getJob(id);
  while (job && (job.status === "pending" || job.status === "in-progress")) {
    await new Promise((r) => setTimeout(r, 15));
    job = await api.getJob(id);
  }
  return job!;
}

/** A jar the way Maven builds one: coordinates in META-INF/maven/…/pom.properties. */
function jar(groupId: string, artifactId: string, version: string): Buffer {
  return Buffer.from(
    zipSync({
      [`META-INF/maven/${groupId}/${artifactId}/pom.properties`]: new Uint8Array(
        Buffer.from(`groupId=${groupId}\nartifactId=${artifactId}\nversion=${version}\n`)
      ),
      "com/acme/Widget.class": new Uint8Array(Buffer.from("CAFEBABE")),
    })
  );
}

/** A real npm tarball: `package/package.json` inside, which is what the sniff reads. */
async function npmTarball(name: string, version: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "tgz-"));
  await mkdir(join(dir, "package"));
  await writeFile(join(dir, "package", "package.json"), JSON.stringify({ name, version }));
  const file = `${name}-${version}.tgz`;
  await execFileAsync("tar", ["-czf", file, "package"], { cwd: dir });
  return readFile(join(dir, file));
}

/** A gzipped tar of `entries`, keyed by the path each takes inside the archive. */
async function tarball(name: string, entries: Record<string, Buffer>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "tar-"));
  for (const [path, body] of Object.entries(entries)) {
    await mkdir(join(dir, "tree", ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(dir, "tree", ...path.split("/")), body);
  }
  await execFileAsync("tar", ["-czf", name, "-C", "tree", "."], { cwd: dir });
  return readFile(join(dir, name));
}

/** Drop `entries` on the Upload tab — the client zips, so this is the zip it sends. */
async function folderUpload(entries: Record<string, Buffer>, folderName: string) {
  const inputs: Record<string, Uint8Array> = {};
  for (const [path, body] of Object.entries(entries)) inputs[path] = new Uint8Array(body);
  const dir = await mkdtemp(join(tmpdir(), "art-"));
  const archivePath = join(dir, "upload.zip");
  await writeFile(archivePath, zipSync(inputs));

  const api = new RealArtifactoryApi();
  const { id } = await api.submitFolderUpload(
    {
      folderName,
      fileCount: Object.keys(entries).length,
      totalBytes: Object.values(entries).reduce((n, b) => n + b.length, 0),
      archivePath,
    },
    user
  );
  return settled(api, id);
}

beforeEach(() => {
  uploaded.clear();
});

describe("an archive that is only carrying a folder is unpacked", () => {
  it("routes a zip of jars exactly as the same jars dropped loose would", async () => {
    const job = await folderUpload(
      { "deps.zip": Buffer.from(zipSync({ "commons-lang3-3.12.0.jar": new Uint8Array(jar("org.apache.commons", "commons-lang3", "3.12.0")) })) },
      "deps"
    );

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual([
      "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
    ]);
  });

  it("unpacks a .tar.gz and keeps the Maven layout inside it", async () => {
    const inner = "org/apache/commons/commons-io/2.11.0/commons-io-2.11.0.jar";
    const job = await folderUpload(
      { "m2.tar.gz": await tarball("m2.tar.gz", { [inner]: jar("org.apache.commons", "commons-io", "2.11.0") }) },
      "m2"
    );

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual([`maven-local/${inner}`]);
  });

  it("leaves an archive that is itself a package alone", async () => {
    // The ordering that matters: a .tgz whose manifest names an npm package is
    // uploaded as that tarball, never torn open and re-routed by its contents.
    const job = await folderUpload({ "widget-2.1.0.tgz": await npmTarball("widget", "2.1.0") }, "drop");

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual(["npm-local/widget/-/widget-2.1.0.tgz"]);
  });

  it("fails naming the archive when there is nothing recognisable inside it", async () => {
    const job = await folderUpload(
      { "docs.zip": Buffer.from(zipSync({ "README.md": new Uint8Array(Buffer.from("hi")) })) },
      "docs"
    );

    expect(job.status).toBe("failed");
    expect(job.errorMessage).toMatch(/No recognised packages in docs/);
    expect(job.log.join("\n")).toMatch(/Nothing recognisable inside docs\.zip/);
    expect(uploaded.size).toBe(0);
  });
});
