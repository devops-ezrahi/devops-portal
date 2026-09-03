import { mkdtempSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalUser } from "../../types";

vi.mock("../../config", () => ({
  config: {
    dataDir: mkdtempSync(join(tmpdir(), "artifactory-folder-url-")),
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

/** What `listSourceFolder` answers for the next copy. */
let folder: { url: string; repoPath: string }[] | null = null;

vi.mock("./artifactoryRest", () => ({
  exists: async () => false,
  listExisting: async () => null,
  upload: async (path: string, localFile: string) => {
    uploaded.set(path, await readFile(localFile));
  },
  webUrl: (path: string) => `https://art.example.com/ui/repos/tree/General/${path}`,
  nativeUrl: (path: string) => `https://art.example.com/ui/native/${path}`,
  listSourceFolder: async () => folder,
  sourceHeaders: () => ({}),
}));

const { RealArtifactoryApi } = await import("./RealArtifactoryApi");

const user: PortalUser = { id: "dana", displayName: "Dana Levi", email: "d@x.io", groups: [] };

function pom(groupId: string, artifactId: string, version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>${groupId}</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>${version}</version>
</project>`;
}

/**
 * Stand a folder up: `files` maps repo-relative path -> its bytes, and both the
 * listing and the per-file downloads are served from it.
 */
function serveFolder(repo: string, prefix: string, files: Record<string, string>) {
  folder = Object.keys(files).map((repoPath) => ({
    url: `https://art.example.com/artifactory/${repo}/${repoPath}`,
    repoPath,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(String(url)).pathname.replace(`/artifactory/${repo}/`, "");
      const body = files[path];
      return body ? new Response(body, { status: 200 }) : new Response("not found", { status: 404 });
    })
  );
  return `https://art.example.com/artifactory/${repo}/${prefix}`;
}

async function settled(api: InstanceType<typeof RealArtifactoryApi>, id: string) {
  let job = await api.getJob(id);
  while (job && (job.status === "pending" || job.status === "in-progress")) {
    await new Promise((r) => setTimeout(r, 15));
    job = await api.getJob(id);
  }
  return job!;
}

beforeEach(() => {
  uploaded.clear();
  folder = null;
  vi.unstubAllGlobals();
});

describe("copying a folder URL", () => {
  it("copies a Maven package's pom and jar together, from the pom's own layout", async () => {
    const base = "org/apache/commons/commons-lang3/3.12.0";
    const url = serveFolder("maven-remote", base, {
      [`${base}/commons-lang3-3.12.0.jar`]: "jar bytes",
      [`${base}/commons-lang3-3.12.0.pom`]: pom("org.apache.commons", "commons-lang3", "3.12.0"),
      [`${base}/commons-lang3-3.12.0.jar.sha1`]: "abc123",
    });

    const api = new RealArtifactoryApi();
    const job = await settled(api, (await api.submitUrlCopy({ sourceUrl: url }, user)).id);

    expect(job.status).toBe("completed");
    // A pom and a jar are one package, not two, so a plain user gets them both.
    expect(job.name).toBe("org.apache.commons:commons-lang3@3.12.0");
    expect([...uploaded.keys()].sort()).toEqual([
      `maven-local/${base}/commons-lang3-3.12.0.jar`,
      `maven-local/${base}/commons-lang3-3.12.0.jar.sha1`,
      `maven-local/${base}/commons-lang3-3.12.0.pom`,
    ]);
  });

  it("refuses a folder holding more than one package for a non-admin", async () => {
    const url = serveFolder("maven-remote", "org/apache/commons", {
      "org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom": pom(
        "org.apache.commons",
        "commons-lang3",
        "3.12.0"
      ),
      "org/apache/commons/commons-io/2.11.0/commons-io-2.11.0.pom": pom(
        "org.apache.commons",
        "commons-io",
        "2.11.0"
      ),
    });

    const api = new RealArtifactoryApi();
    const job = await settled(api, (await api.submitUrlCopy({ sourceUrl: url }, user)).id);

    expect(job.status).toBe("failed");
    expect(job.errorMessage).toMatch(/2 packages/);
    expect(job.errorMessage).toMatch(/admin action/);
    expect(uploaded.size).toBe(0);
  });

  it("copies the whole folder for an admin", async () => {
    const url = serveFolder("maven-remote", "org/apache/commons", {
      "org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom": pom(
        "org.apache.commons",
        "commons-lang3",
        "3.12.0"
      ),
      "org/apache/commons/commons-io/2.11.0/commons-io-2.11.0.pom": pom(
        "org.apache.commons",
        "commons-io",
        "2.11.0"
      ),
    });

    const api = new RealArtifactoryApi();
    const job = await settled(api, (await api.submitUrlCopy({ sourceUrl: url }, user, true)).id);

    expect(job.status).toBe("completed");
    expect([...uploaded.keys()].sort()).toEqual([
      "maven-local/org/apache/commons/commons-io/2.11.0/commons-io-2.11.0.pom",
      "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom",
    ]);
  });

  it("fails naming the folder when nothing in it is a package", async () => {
    const url = serveFolder("generic-local", "docs", {
      "docs/README.txt": "hello",
      "docs/notes.md": "hi",
    });

    const api = new RealArtifactoryApi();
    const job = await settled(api, (await api.submitUrlCopy({ sourceUrl: url }, user)).id);

    expect(job.status).toBe("failed");
    expect(job.errorMessage).toMatch(/No recognised packages in docs/);
    expect(uploaded.size).toBe(0);
  });
});
