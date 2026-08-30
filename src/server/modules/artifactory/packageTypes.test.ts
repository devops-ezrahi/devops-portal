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

const { classify, mavenCoordsFromPom, mavenPomUrl, mavenRootDepth, urlArtifactPath } =
  await import("./packageTypes");

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

describe("mavenPomUrl", () => {
  it("names the pom from the layout, not by swapping the extension", () => {
    const base = "https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.12.0/";
    expect(mavenPomUrl(`${base}commons-lang3-3.12.0.jar`)).toBe(`${base}commons-lang3-3.12.0.pom`);
    // A classifier build still points at the one pom for that version.
    expect(mavenPomUrl(`${base}commons-lang3-3.12.0-sources.jar`)).toBe(`${base}commons-lang3-3.12.0.pom`);
  });

  it("returns null for the pom itself and for a flat path", () => {
    expect(
      mavenPomUrl("https://repo1.maven.org/maven2/org/foo/bar/1.0/bar-1.0.pom")
    ).toBeNull();
    expect(mavenPomUrl("https://mirror.example.com/bar-1.0.jar")).toBeNull();
  });

  it("keeps a query string, so a token on the source URL survives", () => {
    expect(mavenPomUrl("https://art.example.com/repo/org/foo/bar/1.0/bar-1.0.jar?t=x")).toBe(
      "https://art.example.com/repo/org/foo/bar/1.0/bar-1.0.pom?t=x"
    );
  });
});

describe("groupId derived from the path alone", () => {
  it("folds an unrecognised repository root into the groupId", () => {
    // Nexus/JFrog/Central roots are stripped by urlArtifactPath; anything else
    // is not, and the group comes out one or more segments too deep.
    expect(classify(urlArtifactPath("https://mirror.example.com/pub/java/org/foo/bar/1.0/bar-1.0.jar"))).toEqual({
      type: "maven",
      path: "maven-local/pub/java/org/foo/bar/1.0/bar-1.0.jar",
      name: "pub.java.org.foo:bar",
      version: "1.0",
    });
  });
});

describe("mavenCoordsFromPom", () => {
  it("reads the project's own coordinates", () => {
    expect(
      mavenCoordsFromPom(`<?xml version="1.0"?>
        <project xmlns="http://maven.apache.org/POM/4.0.0">
          <modelVersion>4.0.0</modelVersion>
          <groupId>org.apache.commons</groupId>
          <artifactId>commons-lang3</artifactId>
          <version>3.12.0</version>
        </project>`)
    ).toEqual({ groupId: "org.apache.commons", artifactId: "commons-lang3", version: "3.12.0" });
  });

  it("inherits the group and version a child pom omits", () => {
    expect(
      mavenCoordsFromPom(`<project>
          <parent>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-parent</artifactId>
            <version>3.2.0</version>
          </parent>
          <artifactId>spring-boot-starter-web</artifactId>
        </project>`)
    ).toEqual({
      groupId: "org.springframework.boot",
      artifactId: "spring-boot-starter-web",
      version: "3.2.0",
    });
  });

  // The trap: a dependency's groupId is the first one in the file whenever the
  // project inherits its own.
  it("does not mistake a dependency's groupId for the project's", () => {
    expect(
      mavenCoordsFromPom(`<project>
          <parent><groupId>com.acme</groupId><artifactId>root</artifactId><version>1.0</version></parent>
          <artifactId>widget</artifactId>
          <dependencies>
            <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13</version></dependency>
          </dependencies>
        </project>`)
    ).toEqual({ groupId: "com.acme", artifactId: "widget", version: "1.0" });
  });

  it("returns null when a coordinate is missing", () => {
    expect(mavenCoordsFromPom("<project><artifactId>x</artifactId></project>")).toBeNull();
    expect(mavenCoordsFromPom("not xml at all")).toBeNull();
  });

  it("ignores a commented-out parent", () => {
    expect(
      mavenCoordsFromPom(`<project>
          <!-- <parent><groupId>old.group</groupId><version>0.1</version></parent> -->
          <groupId>new.group</groupId><artifactId>x</artifactId><version>2.0</version>
        </project>`)
    ).toEqual({ groupId: "new.group", artifactId: "x", version: "2.0" });
  });
});

describe("mavenRootDepth", () => {
  const coords = { groupId: "org.apache.commons", artifactId: "commons-lang3", version: "3.12.0" };
  const tail = "org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom";

  it("counts the segments above the group root", () => {
    expect(mavenRootDepth(tail, coords)).toBe(0);
    expect(mavenRootDepth(`m2/${tail}`, coords)).toBe(1);
    expect(mavenRootDepth(`deps/.m2/repository/${tail}`, coords)).toBe(3);
  });

  it("refuses a path that disagrees with the pom", () => {
    expect(mavenRootDepth("org/wrong/commons-lang3/3.12.0/commons-lang3-3.12.0.pom", coords)).toBeNull();
    // Right group, wrong version directory.
    expect(mavenRootDepth("org/apache/commons/commons-lang3/9.9.9/commons-lang3-3.12.0.pom", coords)).toBeNull();
    expect(mavenRootDepth("commons-lang3-3.12.0.pom", coords)).toBeNull();
  });
});

describe("classify pypi", () => {
  it("takes a wheel and both sdist shapes, flat at the repo root", () => {
    expect(classify("requests-2.31.0-py3-none-any.whl")).toEqual({
      type: "pypi",
      path: "pypi-local/requests-2.31.0-py3-none-any.whl",
      name: "requests",
      version: "2.31.0",
    });
    expect(classify("wheels/requests-2.31.0.tar.gz")?.path).toBe("pypi-local/requests-2.31.0.tar.gz");
    // A .zip is a Maven artifact extension too, so it only reaches the sdist
    // rule because the Maven layout check declines it first.
    expect(classify("wheels/requests-2.31.0.zip")?.path).toBe("pypi-local/requests-2.31.0.zip");
  });

  it("still prefers the Maven layout for a .zip that has one", () => {
    expect(classify("org/foo/bar/1.0/bar-1.0.zip")).toEqual({
      type: "maven",
      path: "maven-local/org/foo/bar/1.0/bar-1.0.zip",
      name: "org.foo:bar",
      version: "1.0",
    });
  });
});
