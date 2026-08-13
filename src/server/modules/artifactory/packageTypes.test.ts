import { describe, expect, it, vi } from "vitest";

vi.mock("../../config", () => ({
  config: {
    artifactory: {
      url: "https://art.example.com",
      repo: "npm-local",
      npmRepo: "npm-local",
      token: "t",
      mavenRepo: "maven-local",
      rpmRepo: "rpm-local",
      pypiRepo: "pypi-local",
      // Deliberately unset — the "type not configured" case.
      condaRepo: "",
    },
  },
}));

const { classify, urlArtifactPath } = await import("./packageTypes");

describe("classify", () => {
  it("takes Maven coordinates from the repository layout", () => {
    expect(classify("org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar")).toEqual({
      type: "maven",
      path: "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
      name: "org.apache.commons:commons-lang3",
      version: "3.12.0",
    });
  });

  it("carries Maven sidecars along with their artifact", () => {
    const found = classify("org/foo/bar/1.0/bar-1.0.pom.sha1");
    expect(found?.path).toBe("maven-local/org/foo/bar/1.0/bar-1.0.pom.sha1");
  });

  it("skips a flat jar dump rather than guessing the groupId", () => {
    const skipped: string[] = [];
    expect(classify("commons-lang3-3.12.0.jar", (m) => skipped.push(m))).toBeNull();
    // Not a config problem, so nothing is logged — the raw-tree fallback takes it.
    expect(skipped).toEqual([]);
  });

  it("rejects a Maven path whose filename disagrees with the directories", () => {
    expect(classify("org/foo/bar/1.0/something-else.jar")).toBeNull();
  });

  it("puts an RPM flat in the RPM repo", () => {
    expect(classify("pkgs/nginx-1.24.0-1.el9.x86_64.rpm")).toEqual({
      type: "rpm",
      path: "rpm-local/nginx-1.24.0-1.el9.x86_64.rpm",
      name: "nginx",
      version: "1.24.0",
    });
  });

  it("reads name and version off a wheel", () => {
    expect(classify("requests-2.31.0-py3-none-any.whl")).toEqual({
      type: "pypi",
      path: "pypi-local/requests-2.31.0-py3-none-any.whl",
      name: "requests",
      version: "2.31.0",
    });
  });

  it("recognises an sdist by its version field", () => {
    expect(classify("dist/urllib3-2.2.1.tar.gz")).toMatchObject({
      type: "pypi",
      name: "urllib3",
      version: "2.2.1",
    });
  });

  it("returns null and says which env var is missing when a repo is unset", () => {
    const skipped: string[] = [];
    expect(classify("linux-64/numpy-1.26.0-py311h0.conda", (m) => skipped.push(m))).toBeNull();
    expect(skipped).toEqual(["ARTIFACTORY_CONDA_REPO not set — skipping numpy-1.26.0-py311h0.conda"]);
  });

  it("ignores paths it does not recognise", () => {
    expect(classify("README.md")).toBeNull();
    expect(classify("")).toBeNull();
  });
});

describe("classify conda", () => {
  // The mock above leaves condaRepo empty, so this block gets its own config.
  it("takes the subdir from the channel directory, else noarch", async () => {
    vi.resetModules();
    vi.doMock("../../config", () => ({
      config: { artifactory: { repo: "npm-local",
      npmRepo: "npm-local", condaRepo: "conda-local" } },
    }));
    const { classify: c } = await import("./packageTypes");

    expect(c("channel/linux-64/numpy-1.26.0-py311h0.conda")).toEqual({
      type: "conda",
      path: "conda-local/linux-64/numpy-1.26.0-py311h0.conda",
      name: "numpy",
      version: "1.26.0",
    });
    expect(c("numpy-1.26.0-py311h0.tar.bz2")?.path).toBe("conda-local/noarch/numpy-1.26.0-py311h0.tar.bz2");
  });
});

describe("urlArtifactPath", () => {
  it("strips the repository root so the Maven layout check lines up", () => {
    expect(
      urlArtifactPath("https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar")
    ).toBe("org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar");

    expect(urlArtifactPath("https://art.example.com/artifactory/libs-release/org/foo/bar/1.0/bar-1.0.jar")).toBe(
      "org/foo/bar/1.0/bar-1.0.jar"
    );

    expect(urlArtifactPath("https://mirror.example.com/nginx-1.24.0-1.el9.x86_64.rpm")).toBe(
      "nginx-1.24.0-1.el9.x86_64.rpm"
    );
  });
});
