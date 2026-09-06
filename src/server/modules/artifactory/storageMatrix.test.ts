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
    dataDir: mkdtempSync(join(tmpdir(), "artifactory-matrix-")),
    artifactory: {
      url: "https://art.example.com",
      repo: "npm-local",
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

/** Every PUT this run made: repo-relative path -> the bytes uploaded. */
const uploaded = new Map<string, Buffer>();

// Resolving for real spawns `mvn`, which reaches for the source repository over
// the network. A dev box usually has no maven, so the resolve answered "not
// installed" and this file passed by accident; a CI runner ships with maven, so
// the same test spent its whole timeout on DNS for mirror.example.com. `null` is
// that same "not installed" answer, now stated rather than inherited from the
// host — which is what keeps the job named after the coordinates the pom
// declares. Only the resolvers are stubbed: the URL helpers beside them derive
// the repository root this file asserts on.
vi.mock("./toolDependencies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./toolDependencies")>()),
  resolveMavenDependencies: async () => null,
  resolvePypiDependencies: async () => null,
}));

vi.mock("./artifactoryRest", () => ({
  exists: async () => false,
  listExisting: async () => null,
  upload: async (path: string, localFile: string) => {
    uploaded.set(path, await readFile(localFile));
  },
  webUrl: (path: string) => `https://art.example.com/ui/repos/tree/General/${path}`,
  nativeUrl: (path: string) => `https://art.example.com/ui/native/${path}`,
}));

const { RealArtifactoryApi } = await import("./RealArtifactoryApi");

const user: PortalUser = { id: "dana", displayName: "Dana Levi", email: "d@x.io", groups: [] };

/** A pom carrying real coordinates — what the target path is derived from. */
function pom(groupId: string, artifactId: string, version: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>${groupId}</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>${version}</version>
</project>`
  );
}

async function settled(api: InstanceType<typeof RealArtifactoryApi>, id: string) {
  let job = await api.getJob(id);
  while (job && (job.status === "pending" || job.status === "in-progress")) {
    await new Promise((r) => setTimeout(r, 15));
    job = await api.getJob(id);
  }
  return job!;
}

/** A real npm tarball: `package/package.json` inside, which is what the sniff reads. */
async function npmTarball(name: string, version: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "tgz-"));
  await mkdir(join(dir, "package"));
  await writeFile(join(dir, "package", "package.json"), JSON.stringify({ name, version }));
  const file = `${name.split("/").pop()}-${version}.tgz`;
  await execFileAsync("tar", ["-czf", file, "package"], { cwd: dir });
  return readFile(join(dir, file));
}

/**
 * A real Helm chart: `<chart>/Chart.yaml` inside, plus a bundled subchart —
 * the subchart's own Chart.yaml is what a greedy wildcard would read instead.
 */
async function helmChart(name: string, version: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "chart-"));
  await mkdir(join(dir, name, "charts", "common"), { recursive: true });
  await writeFile(
    join(dir, name, "Chart.yaml"),
    `apiVersion: v2\nname: ${name}\ndescription: A chart\ntype: application\nversion: ${version}\nappVersion: "7.2.4"\n`
  );
  await writeFile(
    join(dir, name, "charts", "common", "Chart.yaml"),
    `apiVersion: v2\nname: common\nversion: 2.20.0\n`
  );
  const file = `${name}-${version}.tgz`;
  await execFileAsync("tar", ["-czf", file, name], { cwd: dir });
  return readFile(join(dir, file));
}

/** Serve a fixed set of URLs; anything else 404s, as a real source would. */
function serveUrls(files: Record<string, Buffer>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const key = new URL(String(url)).pathname;
      const body = files[key];
      return body
        ? new Response(new Uint8Array(body), { status: 200 })
        : new Response("not found", { status: 404 });
    })
  );
}

/** A jar the way Maven builds one: coordinates in META-INF/maven/…/pom.properties. */
function jar(groupId: string, artifactId: string, version: string): Buffer {
  return Buffer.from(
    zipSync({
      [`META-INF/maven/${groupId}/${artifactId}/pom.properties`]: new Uint8Array(
        Buffer.from(`#Generated by Maven\ngroupId=${groupId}\nartifactId=${artifactId}\nversion=${version}\n`)
      ),
      "com/acme/Widget.class": new Uint8Array(Buffer.from("CAFEBABE")),
    })
  );
}

async function urlCopy(sourceUrl: string, includeDependencies = false) {
  const api = new RealArtifactoryApi();
  const { id } = await api.submitUrlCopy({ sourceUrl, includeDependencies }, user);
  return settled(api, id);
}

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
  vi.unstubAllGlobals();
});

// Each type's storage layout, pinned against what Artifactory's own indexers
// expect: npm reads the tarball at `<name>/-/<file>.tgz`, Maven reads the
// group/artifact/version layout (and rejects a pom deployed off-path with a
// 409), and the PyPI and YUM indexers read the file itself, so those two are
// flat at the repo root — `pypi-repo/simple/**` and `packages/**` are reserved.
describe("url copy stores each type where its indexer looks", () => {
  it("npm: scoped tarball keeps the registry layout", async () => {
    const tgz = await npmTarball("@acme/widget", "2.1.0");
    serveUrls({ "/npm/@acme/widget/-/widget-2.1.0.tgz": tgz });
    const job = await urlCopy("https://src.example.com/npm/@acme/widget/-/widget-2.1.0.tgz");

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual(["npm-local/@acme/widget/-/widget-2.1.0.tgz"]);
    // Byte-identical to what the source served: the integrity hash in a
    // consumer's lockfile is over these bytes.
    expect(uploaded.get("npm-local/@acme/widget/-/widget-2.1.0.tgz")).toEqual(tgz);
  });

  it("helm: a chart is flat at the repo root, read from its own Chart.yaml", async () => {
    const tgz = await helmChart("redis", "19.6.1");
    // The URL says nothing useful — .tgz is npm's extension too, and this one
    // is not even in a registry layout. The manifest inside is what decides.
    serveUrls({ "/charts/redis-19.6.1.tgz": tgz });
    const job = await urlCopy("https://charts.example.com/charts/redis-19.6.1.tgz");

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual(["helm-local/redis-19.6.1.tgz"]);
    expect(job.name).toBe("redis@19.6.1");
  });

  it("npm: a tarball with no readable manifest still keeps the registry layout", async () => {
    // Not a gzipped tar at all — the sniff can only fail. The URL is a registry
    // layout, and that is enough to place it: without this it was uploaded flat
    // as `types-16.0.0.tgz` and lost its scope.
    serveUrls({
      "/artifactory/dvps-npm-local/%40octokit/types/-/types-16.0.0.tgz": Buffer.from("not a tarball"),
    });
    const job = await urlCopy(
      "https://art.example.com/artifactory/dvps-npm-local/%40octokit/types/-/types-16.0.0.tgz"
    );

    expect(job.log.join("\n")).toContain("registry URL");
    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual(["npm-local/@octokit/types/-/types-16.0.0.tgz"]);
  });

  it("takes an Artifactory UI link, which is what people copy out of the browser", async () => {
    const tgz = await npmTarball("@acme/widget", "2.1.0");
    serveUrls({ "/artifactory/npm-remote/@acme/widget/-/widget-2.1.0.tgz": tgz });
    const job = await urlCopy(
      "https://art.example.com/ui/repos/tree/General/npm-remote/@acme/widget/-/widget-2.1.0.tgz"
    );

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual(["npm-local/@acme/widget/-/widget-2.1.0.tgz"]);
  });

  it("maven: jar lands in its group layout, with the pom beside it", async () => {
    serveUrls({
      "/maven2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar": Buffer.from("JAR"),
      "/maven2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom": pom(
        "org.apache.commons",
        "commons-lang3",
        "3.12.0"
      ),
    });
    const job = await urlCopy(
      "https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar"
    );

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()].sort()).toEqual([
      "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
      "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom",
    ]);
  });

  it("pypi: a wheel is flat at the repo root", async () => {
    serveUrls({ "/packages/py3/r/requests/requests-2.31.0-py3-none-any.whl": Buffer.from("WHL") });
    const job = await urlCopy(
      "https://files.pythonhosted.org/packages/py3/r/requests/requests-2.31.0-py3-none-any.whl"
    );

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual(["pypi-local/requests-2.31.0-py3-none-any.whl"]);
  });

  it("pypi: an sdist is flat at the repo root too", async () => {
    serveUrls({ "/packages/source/r/requests/requests-2.31.0.tar.gz": Buffer.from("SDIST") });
    const job = await urlCopy(
      "https://files.pythonhosted.org/packages/source/r/requests/requests-2.31.0.tar.gz"
    );

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual(["pypi-local/requests-2.31.0.tar.gz"]);
  });

  it("rpm: flat at the repo root, where the default YUM depth indexes", async () => {
    serveUrls({ "/pub/epel/9/x86_64/nginx-1.24.0-1.el9.x86_64.rpm": Buffer.from("RPM") });
    const job = await urlCopy("https://mirror.example.com/pub/epel/9/x86_64/nginx-1.24.0-1.el9.x86_64.rpm");

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual(["rpm-local/nginx-1.24.0-1.el9.x86_64.rpm"]);
  });
});

describe("folder upload stores each type where its indexer looks", () => {
  it("routes a mixed drop, one file per type, and drops nothing", async () => {
    const job = await folderUpload(
      {
        "node_modules/@acme/widget/package.json": Buffer.from(
          JSON.stringify({ name: "@acme/widget", version: "2.1.0" })
        ),
        "node_modules/@acme/widget/index.js": Buffer.from("x"),
        "m2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar": Buffer.from("JAR"),
        "m2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom": pom(
          "org.apache.commons",
          "commons-lang3",
          "3.12.0"
        ),
        "wheels/requests-2.31.0-py3-none-any.whl": Buffer.from("WHL"),
        "wheels/requests-2.31.0.tar.gz": Buffer.from("SDIST"),
        "rpms/nginx-1.24.0-1.el9.x86_64.rpm": Buffer.from("RPM"),
      },
      "offline-bundle"
    );

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()].sort()).toEqual([
      "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
      "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom",
      "npm-local/@acme/widget/-/widget-2.1.0.tgz",
      "pypi-local/requests-2.31.0-py3-none-any.whl",
      "pypi-local/requests-2.31.0.tar.gz",
      "rpm-local/nginx-1.24.0-1.el9.x86_64.rpm",
    ]);
    expect(job.log.some((l) => l.includes("unrelated"))).toBe(false);
  });

  it("takes a folder of loose npm tarballs, scope and all", async () => {
    const job = await folderUpload(
      {
        "tarballs/widget-2.1.0.tgz": await npmTarball("@acme/widget", "2.1.0"),
        "tarballs/left-pad-1.3.0.tgz": await npmTarball("left-pad", "1.3.0"),
      },
      "tarballs"
    );

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()].sort()).toEqual([
      "npm-local/@acme/widget/-/widget-2.1.0.tgz",
      "npm-local/left-pad/-/left-pad-1.3.0.tgz",
    ]);
  });
});

// The groupId cannot be read off a path: `.../pub/java/org/foo/bar/1.0/bar-1.0.jar`
// is a valid layout under three different roots. The pom is the authority, and
// Artifactory enforces it — a pom deployed off its own coordinates is a 409.
describe("the pom decides the Maven target, not the path", () => {
  it("url copy: corrects the group when the URL sits under an unknown root", async () => {
    serveUrls({
      "/pub/java/org/foo/bar/1.0/bar-1.0.jar": Buffer.from("JAR"),
      "/pub/java/org/foo/bar/1.0/bar-1.0.pom": pom("org.foo", "bar", "1.0"),
    });
    const job = await urlCopy("https://mirror.example.com/pub/java/org/foo/bar/1.0/bar-1.0.jar");

    expect(job.status).toBe("completed");
    // Not maven-local/pub/java/org/foo/... — the `pub/java` root is stripped
    // because the pom says the group is `org.foo`.
    expect([...uploaded.keys()].sort()).toEqual([
      "maven-local/org/foo/bar/1.0/bar-1.0.jar",
      "maven-local/org/foo/bar/1.0/bar-1.0.pom",
    ]);
    expect(job.name).toBe("org.foo:bar@1.0");
  });

  it("url copy: keeps the path-derived target when there is no pom to read", async () => {
    serveUrls({ "/maven2/org/foo/bar/1.0/bar-1.0.jar": Buffer.from("JAR") });
    const job = await urlCopy("https://repo1.maven.org/maven2/org/foo/bar/1.0/bar-1.0.jar");

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual(["maven-local/org/foo/bar/1.0/bar-1.0.jar"]);
    expect(job.log.some((l) => l.includes("No sibling pom (404)"))).toBe(true);
  });

  // A pasted .pom has no sibling to fetch — it *is* the pom — so its own bytes
  // are the authority for both the target path and the dependency resolve.
  it("url copy: reads a pasted pom's coordinates out of the pom itself", async () => {
    serveUrls({ "/pub/java/org/foo/bar/1.0/bar-1.0.pom": pom("org.foo", "bar", "1.0") });
    const job = await urlCopy("https://mirror.example.com/pub/java/org/foo/bar/1.0/bar-1.0.pom", true);

    expect(job.status).toBe("completed");
    // One upload, not two: the pom is the artifact, not a sibling beside it.
    expect([...uploaded.keys()]).toEqual(["maven-local/org/foo/bar/1.0/bar-1.0.pom"]);
    expect(job.name?.startsWith("org.foo:bar")).toBe(true);
    expect(job.log.some((l) => l.includes("No pom for this artifact"))).toBe(false);
  });

  // The pair travels together in both directions: a jar alone is unresolvable
  // and a pom alone resolves to nothing to run.
  it("url copy: a pasted pom brings its jar", async () => {
    serveUrls({
      "/pub/java/org/foo/bar/1.0/bar-1.0.pom": pom("org.foo", "bar", "1.0"),
      "/pub/java/org/foo/bar/1.0/bar-1.0.jar": Buffer.from("JAR"),
    });
    const job = await urlCopy("https://mirror.example.com/pub/java/org/foo/bar/1.0/bar-1.0.pom");

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()].sort()).toEqual([
      "maven-local/org/foo/bar/1.0/bar-1.0.jar",
      "maven-local/org/foo/bar/1.0/bar-1.0.pom",
    ]);
  });

  // A BOM or a parent pom has no jar at all, and that is the same 404 as a jar
  // published without one — quiet, and the copy still completes.
  it("url copy: a pasted pom with no jar beside it still completes", async () => {
    serveUrls({ "/pub/java/org/foo/bar/1.0/bar-1.0.pom": pom("org.foo", "bar", "1.0") });
    const job = await urlCopy("https://mirror.example.com/pub/java/org/foo/bar/1.0/bar-1.0.pom");

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()]).toEqual(["maven-local/org/foo/bar/1.0/bar-1.0.pom"]);
  });

  it("folder upload: strips whatever the tree is nested under", async () => {
    const job = await folderUpload(
      {
        "deps/.m2/repository/org/foo/bar/1.0/bar-1.0.jar": Buffer.from("JAR"),
        "deps/.m2/repository/org/foo/bar/1.0/bar-1.0.pom": pom("org.foo", "bar", "1.0"),
        "deps/.m2/repository/org/foo/bar/1.0/bar-1.0.jar.sha1": Buffer.from("abc123"),
        // Maven's own bookkeeping, which is not an artifact.
        "deps/.m2/repository/org/foo/bar/1.0/_remote.repositories": Buffer.from("#"),
      },
      "deps"
    );

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()].sort()).toEqual([
      "maven-local/org/foo/bar/1.0/bar-1.0.jar",
      "maven-local/org/foo/bar/1.0/bar-1.0.jar.sha1",
      "maven-local/org/foo/bar/1.0/bar-1.0.pom",
    ]);
    expect(job.log).toContain("Maven repository root: deps/.m2/repository/ — stripped from the target paths.");
  });

  it("folder upload: a tree already at the root is left alone", async () => {
    const job = await folderUpload(
      {
        "org/foo/bar/1.0/bar-1.0.jar": Buffer.from("JAR"),
        "org/foo/bar/1.0/bar-1.0.pom": pom("org.foo", "bar", "1.0"),
      },
      "repository"
    );

    expect([...uploaded.keys()].sort()).toEqual([
      "maven-local/org/foo/bar/1.0/bar-1.0.jar",
      "maven-local/org/foo/bar/1.0/bar-1.0.pom",
    ]);
    expect(job.log.some((l) => l.includes("Maven repository root"))).toBe(false);
  });
});

// `mvn dependency:copy-dependencies` writes a flat folder of jars — no layout,
// no poms — and that is what most people have when they need an offline bundle.
// The filename cannot give a groupId, but the jar itself can.
describe("a flat folder of jars", () => {
  it("takes each jar's coordinates from its own META-INF/maven", async () => {
    const job = await folderUpload(
      {
        "commons-lang3-3.12.0.jar": jar("org.apache.commons", "commons-lang3", "3.12.0"),
        "guava-32.1.3-jre.jar": jar("com.google.guava", "guava", "32.1.3-jre"),
      },
      "dependency"
    );

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()].sort()).toEqual([
      "maven-local/com/google/guava/guava/32.1.3-jre/guava-32.1.3-jre.jar",
      "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
    ]);
  });

  it("keeps a classifier, and renames a jar that was renamed", async () => {
    const job = await folderUpload(
      {
        "commons-lang3-3.12.0-sources.jar": jar("org.apache.commons", "commons-lang3", "3.12.0"),
        "renamed-by-someone.jar": jar("com.acme", "widget", "1.0"),
      },
      "jars"
    );

    expect([...uploaded.keys()].sort()).toEqual([
      "maven-local/com/acme/widget/1.0/widget-1.0.jar",
      "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0-sources.jar",
    ]);
  });

  it("leaves a jar with no coordinates in it as an unrelated file", async () => {
    const job = await folderUpload({ "mystery.jar": Buffer.from("not even a zip") }, "jars");

    expect(job.status).toBe("failed");
    expect(job.errorMessage).toContain("No recognised packages");
  });
});

it("url copy: a jar off a flat file server is placed by its own coordinates", async () => {
  serveUrls({ "/downloads/widget.jar": jar("com.acme", "widget", "1.0") });
  const job = await urlCopy("https://files.example.com/downloads/widget.jar");

  expect(job.status).toBe("completed");
  // Not npm-local/widget.jar, which is where an unrecognised file goes.
  expect([...uploaded.keys()]).toEqual(["maven-local/com/acme/widget/1.0/widget-1.0.jar"]);
});
