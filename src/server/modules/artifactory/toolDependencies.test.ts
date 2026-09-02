import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
      condaRepo: "",
    },
  },
}));

const { itemsFromResolvedDir, mavenRepoFromUrl, pypiIndexFromUrl, pypiSpec, validMavenCoords } =
  await import("./toolDependencies");

const coords = { groupId: "org.apache.commons", artifactId: "commons-lang3", version: "3.12.0" };

describe("mavenRepoFromUrl", () => {
  it("strips the coordinates off a Maven Central URL", () => {
    expect(
      mavenRepoFromUrl(
        "https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
        coords,
        "commons-lang3-3.12.0.jar"
      )
    ).toBe("https://repo1.maven.org/maven2");
  });

  it("handles an Artifactory repository path", () => {
    expect(
      mavenRepoFromUrl(
        "https://art.example.com/artifactory/libs-release/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
        coords,
        "commons-lang3-3.12.0.jar"
      )
    ).toBe("https://art.example.com/artifactory/libs-release");
  });

  it("takes the filename it is given, so a classifier jar still resolves", () => {
    expect(
      mavenRepoFromUrl(
        "https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0-sources.jar",
        coords,
        "commons-lang3-3.12.0-sources.jar"
      )
    ).toBe("https://repo1.maven.org/maven2");
  });

  it("returns the bare origin when the artifact sits at the root", () => {
    expect(
      mavenRepoFromUrl(
        "https://repo.example.com/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
        coords,
        "commons-lang3-3.12.0.jar"
      )
    ).toBe("https://repo.example.com");
  });

  it("is null when the URL does not sit at the coordinates", () => {
    expect(
      mavenRepoFromUrl(
        "https://files.example.com/downloads/commons-lang3-3.12.0.jar",
        coords,
        "commons-lang3-3.12.0.jar"
      )
    ).toBeNull();
  });

  it("is null for a non-http URL and for junk", () => {
    expect(mavenRepoFromUrl("file:///tmp/a.jar", coords, "a.jar")).toBeNull();
    expect(mavenRepoFromUrl("not a url", coords, "a.jar")).toBeNull();
  });
});

describe("pypiIndexFromUrl", () => {
  it("maps the PyPI CDN host to pypi.org, which is where the index lives", () => {
    expect(
      pypiIndexFromUrl(
        "https://files.pythonhosted.org/packages/2a/1f/abcdef/idna-3.6-py3-none-any.whl"
      )
    ).toBe("https://pypi.org/simple");
  });

  it("puts the index beside packages/ on Artifactory", () => {
    expect(
      pypiIndexFromUrl(
        "https://art.example.com/artifactory/api/pypi/pypi-remote/packages/packages/2a/1f/ab/idna-3.6-py3-none-any.whl"
      )
    ).toBe("https://art.example.com/artifactory/api/pypi/pypi-remote/simple");
  });

  it("does the same for Nexus", () => {
    expect(
      pypiIndexFromUrl("https://nexus.example.com/repository/pypi-all/packages/idna/3.6/idna-3.6.whl")
    ).toBe("https://nexus.example.com/repository/pypi-all/simple");
  });

  // The shape Artifactory's own UI links to, and therefore what people paste.
  it("uses the pypi API endpoint for an Artifactory storage path", () => {
    expect(
      pypiIndexFromUrl(
        "https://artifactory.app.iaf/artifactory/pypi-proxy-idf.cts-cache/hatch-fancy-pypi-readme/-/hatch_fancy_pypi_readme-25.1.0-py3-none-any.whl"
      )
    ).toBe("https://artifactory.app.iaf/artifactory/api/pypi/pypi-proxy-idf.cts-cache/simple");
  });

  it("is null for a flat file server with no packages/ segment", () => {
    expect(pypiIndexFromUrl("https://files.example.com/downloads/idna-3.6-py3-none-any.whl")).toBeNull();
  });

  it("is null for a non-http URL and for junk", () => {
    expect(pypiIndexFromUrl("file:///tmp/packages/a.whl")).toBeNull();
    expect(pypiIndexFromUrl("not a url")).toBeNull();
  });
});

describe("pypiSpec", () => {
  it("joins a valid name and version", () => {
    expect(pypiSpec("typing_extensions", "4.9.0")).toBe("typing_extensions==4.9.0");
    expect(pypiSpec("zope.interface", "6.1")).toBe("zope.interface==6.1");
  });

  it("refuses anything that would reach pip's argv as something else", () => {
    expect(pypiSpec("-r/etc/passwd", "1.0")).toBeNull();
    expect(pypiSpec("idna; rm -rf /", "3.6")).toBeNull();
    expect(pypiSpec("../../etc", "3.6")).toBeNull();
    expect(pypiSpec("idna", "3.6 --index-url=http://evil")).toBeNull();
    expect(pypiSpec("", "3.6")).toBeNull();
  });
});

describe("validMavenCoords", () => {
  it("accepts real coordinates", () => {
    expect(validMavenCoords(coords)).toBe(true);
  });

  it("refuses a path or a shell metacharacter", () => {
    expect(validMavenCoords({ ...coords, groupId: "../../etc" })).toBe(false);
    expect(validMavenCoords({ ...coords, artifactId: "a b" })).toBe(false);
    expect(validMavenCoords({ ...coords, version: "1.0</version><x>" })).toBe(false);
  });
});

describe("itemsFromResolvedDir", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "resolved-"));

    // What `mvn -Dmdep.useRepositoryLayout=true -Dmdep.copyPom=true` writes.
    const mvn = join(dir, "mvn");
    const layout = join(mvn, "org/apache/commons/commons-lang3/3.12.0");
    await mkdir(layout, { recursive: true });
    await writeFile(join(layout, "commons-lang3-3.12.0.jar"), "jar");
    await writeFile(join(layout, "commons-lang3-3.12.0.pom"), "<project/>");

    // What `pip download -d` writes: one flat directory.
    const pip = join(dir, "pip");
    await mkdir(pip, { recursive: true });
    await writeFile(join(pip, "idna-3.6-py3-none-any.whl"), "whl");
    await writeFile(join(pip, "certifi-2024.2.2-py3-none-any.whl"), "whl");
  });

  it("maps the Maven repository layout straight onto its target path", async () => {
    const items = await itemsFromResolvedDir(join(dir, "mvn"));
    expect(items.map((i) => i.path).sort()).toEqual([
      "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
      "maven-local/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom",
    ]);
    expect(items[0].type).toBe("maven");
    expect(items[0].name).toBe("org.apache.commons:commons-lang3");
    expect(items[0].version).toBe("3.12.0");
  });

  it("maps a flat wheel directory onto the flat pypi layout", async () => {
    const items = await itemsFromResolvedDir(join(dir, "pip"));
    expect(items.map((i) => i.path).sort()).toEqual([
      "pypi-local/certifi-2024.2.2-py3-none-any.whl",
      "pypi-local/idna-3.6-py3-none-any.whl",
    ]);
    expect(items.every((i) => i.type === "pypi")).toBe(true);
  });

  it("resolves each item to the file it walked", async () => {
    const [item] = await itemsFromResolvedDir(join(dir, "pip"));
    expect(await item.resolve()).toContain(".whl");
  });

  it("skips what classify does not recognise, rather than guessing", async () => {
    const stray = join(dir, "stray");
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, "README.txt"), "hi");
    // A flat jar carries no groupId, so it has no derivable target either.
    await writeFile(join(stray, "commons-lang3-3.12.0.jar"), "jar");
    expect(await itemsFromResolvedDir(stray)).toEqual([]);
  });

  it("is empty for a directory that does not exist", async () => {
    expect(await itemsFromResolvedDir(join(dir, "nope"))).toEqual([]);
  });
});

describe("the maven project it hands to mvn", () => {
  it("declares the artifact as its single dependency", async () => {
    const { stubPom } = await import("./toolDependencies");
    const pom = stubPom(coords);
    expect(pom).toContain("<groupId>org.apache.commons</groupId>");
    expect(pom).toContain("<artifactId>commons-lang3</artifactId>");
    expect(pom).toContain("<version>3.12.0</version>");
    // packaging pom, so maven never tries to build or test anything.
    expect(pom).toContain("<packaging>pom</packaging>");
  });

  it("mirrors everything at the source repo, so Central is never reached", async () => {
    const { mavenSettings } = await import("./toolDependencies");
    const xml = mavenSettings("https://art.example.com/artifactory/libs-release", "");
    expect(xml).toContain("<mirrorOf>*</mirrorOf>");
    expect(xml).toContain("<url>https://art.example.com/artifactory/libs-release</url>");
    // No credentials means no <servers> block at all, not an empty one.
    expect(xml).not.toContain("<servers>");
  });

  it("carries the token as a password, and only when there is one", async () => {
    const { mavenSettings } = await import("./toolDependencies");
    const xml = mavenSettings("https://art.example.com/repo", "tok123");
    expect(xml).toContain("<password>tok123</password>");
    // The server id has to match the mirror id or maven never applies it.
    expect(xml.match(/<id>source<\/id>/g)).toHaveLength(2);
  });
});
